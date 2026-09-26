import { z } from "zod";
import { HAError } from "../../ha-client.js";
import { DESTRUCTIVE, READ_ONLY, WRITE, defineTool, type HAState, type ToolContext } from "../common.js";
import { CAP, defined, matches, ws } from "./util.js";

export function registerSystemTools(ctx: ToolContext) {
  const { ha } = ctx;

  defineTool(
    ctx,
    "ha_restart",
    {
      title: "Restart Home Assistant",
      description:
        "Restart Home Assistant Core. All automations stop and the UI is unavailable for a minute or more. " +
        "The configuration is checked first and the restart is refused if it is invalid (skip_config_check=true to skip). " +
        "Requires confirm=true; only restart when the user asked for it.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true"),
        skip_config_check: z.boolean().default(false),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ confirm, skip_config_check }) => {
      if (confirm !== true) throw new HAError("Refusing to restart: pass confirm=true");
      if (!skip_config_check) {
        const check = await ha.post<any>("/api/config/core/check_config", {}, CAP);
        if (check?.result && check.result !== "valid") {
          return { restarted: false, reason: "Configuration is invalid; fix it first", check };
        }
      }
      try {
        await ha.callService("homeassistant", "restart", {}, CAP);
      } catch (err) {
        // The connection often drops while Home Assistant shuts down.
        if (!/Could not reach|closed|reset|socket|50[234]/i.test((err as Error).message)) throw err;
      }
      return { restarted: true, note: "Restart requested. Home Assistant will be unavailable for a short while." };
    },
  );

  // ---------------------------------------------------------------- repairs

  defineTool(
    ctx,
    "ha_list_repairs",
    {
      title: "List repair issues",
      description:
        "List repair issues (Settings → System → Repairs): domain, issue_id, severity, whether it is fixable (then fix it with ha_integration_flow flow='repair'), ignored, breaks_in_ha_version and learn_more_url.",
      inputSchema: {
        include_ignored: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    async ({ include_ignored }) => {
      const res = await ha.wsRead<{ issues: any[] }>("repairs/list_issues");
      return (res?.issues ?? [])
        .filter((i) => include_ignored || !i.ignored)
        .map((i) =>
          defined({
            domain: i.domain,
            issue_domain: i.issue_domain ?? undefined,
            issue_id: i.issue_id,
            severity: i.severity,
            is_fixable: i.is_fixable,
            ignored: i.ignored,
            translation_key: i.translation_key ?? undefined,
            translation_placeholders: i.translation_placeholders ?? undefined,
            breaks_in_ha_version: i.breaks_in_ha_version ?? undefined,
            learn_more_url: i.learn_more_url ?? undefined,
            created: i.created,
          }),
        );
    },
  );

  defineTool(
    ctx,
    "ha_ignore_repair",
    {
      title: "Ignore or un-ignore a repair issue",
      description: "Ignore a repair issue (hide it) or un-ignore it (ignore=false). Use domain and issue_id from ha_list_repairs.",
      inputSchema: {
        domain: z.string(),
        issue_id: z.string(),
        ignore: z.boolean().default(true),
      },
      annotations: WRITE,
    },
    async ({ domain, issue_id, ignore }) => {
      await ws(ha, "repairs/ignore_issue", { domain, issue_id, ignore });
      return { domain, issue_id, ignored: ignore };
    },
  );

  // ---------------------------------------------------------------- updates

  defineTool(
    ctx,
    "ha_list_updates",
    {
      title: "List available updates",
      description:
        "List update entities with installed and latest version, title, release notes URL and whether an install is in progress. By default only those with an update available.",
      inputSchema: {
        include_up_to_date: z.boolean().default(false),
        search: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ include_up_to_date, search }) => {
      const states = await ha.get<HAState[]>("/api/states");
      return states
        .filter((s) => s.entity_id.startsWith("update.") && (include_up_to_date || s.state === "on"))
        .filter((s) => matches(search, s.entity_id, s.attributes?.friendly_name, s.attributes?.title))
        .map((s) => {
          const a = s.attributes ?? {};
          return defined({
            entity_id: s.entity_id,
            name: a.friendly_name,
            title: a.title ?? undefined,
            update_available: s.state === "on",
            installed_version: a.installed_version,
            latest_version: a.latest_version,
            skipped_version: a.skipped_version ?? undefined,
            in_progress: a.in_progress || undefined,
            auto_update: a.auto_update || undefined,
            release_url: a.release_url ?? undefined,
            release_summary: a.release_summary ?? undefined,
          });
        });
    },
  );

  defineTool(
    ctx,
    "ha_install_update",
    {
      title: "Install an update",
      description:
        "Install an update for an update entity (see ha_list_updates), optionally a specific version and with a backup first (if the integration supports it). " +
        "Updates can restart the affected integration, add-on or Home Assistant itself. Long installs may time out here while they continue; check progress with ha_list_updates.",
      inputSchema: {
        entity_id: z.string().regex(/^update\./, "must be an update.* entity"),
        version: z.string().optional(),
        backup: z.boolean().optional().describe("Create a backup before installing (if supported)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ entity_id, version, backup }) => {
      await ha.callService("update", "install", { target: { entity_id }, data: defined({ version, backup }) }, CAP);
      return { installing: entity_id, version: version ?? "latest" };
    },
  );

  // ---------------------------------------------------------------- logging

  defineTool(
    ctx,
    "ha_set_log_level",
    {
      title: "Set log level",
      description:
        "Change how much Home Assistant logs, e.g. turn on debug logging for one integration while troubleshooting (then read ha_get_error_log).\n" +
        "- integration: an integration domain, e.g. 'zha'.\n- module: a Python logger name, e.g. 'homeassistant.components.mqtt'.\n- neither: sets the default level for everything.\n" +
        "persistence: 'none' (until restart, default), 'once' (also for the next start) or 'permanent'. Without level, returns the current integration log levels.",
      inputSchema: {
        level: z.enum(["debug", "info", "warning", "error", "critical"]).optional(),
        integration: z.string().optional(),
        module: z.string().optional(),
        persistence: z.enum(["none", "once", "permanent"]).default("none"),
      },
      annotations: WRITE,
    },
    async ({ level, integration, module, persistence }) => {
      if (!level) return ws(ha, "logger/log_info");
      if (integration && module) throw new HAError("Pass either integration or module, not both");
      const LEVEL = level.toUpperCase();
      if (integration) {
        await ws(ha, "logger/integration_log_level", { integration, level: LEVEL, persistence });
        return { integration, level, persistence };
      }
      if (module) {
        await ws(ha, "logger/log_level", { module, level: LEVEL, persistence });
        return { module, level, persistence };
      }
      await ha.callService("logger", "set_default_level", { data: { level } }, CAP);
      return { default_level: level };
    },
  );

  // --------------------------------------------------------------- recorder

  defineTool(
    ctx,
    "ha_purge_recorder",
    {
      title: "Purge recorder history",
      description:
        "Permanently delete recorded history from the database.\n" +
        "- Without entity filters: purge everything older than keep_days (default: the recorder's purge_keep_days). repack=true also shrinks the database file (slow). apply_filter=true also removes data excluded by the recorder include/exclude config.\n" +
        "- With entity_id / domains / entity_globs: delete history of just those entities older than keep_days (default 0 = all of it).\n" +
        "Requires confirm=true. Cannot be undone.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true"),
        keep_days: z.number().int().min(0).optional(),
        repack: z.boolean().optional(),
        apply_filter: z.boolean().optional(),
        entity_id: z.array(z.string()).optional(),
        domains: z.array(z.string()).optional(),
        entity_globs: z.array(z.string()).optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ confirm, keep_days, repack, apply_filter, entity_id, domains, entity_globs }) => {
      if (confirm !== true) throw new HAError("Refusing to purge: pass confirm=true");
      const targeted = Boolean(entity_id?.length || domains?.length || entity_globs?.length);
      if (targeted) {
        await ha.callService(
          "recorder",
          "purge_entities",
          {
            target: entity_id?.length ? { entity_id } : undefined,
            data: defined({ domains, entity_globs, keep_days }),
          },
          CAP,
        );
        return { purged: "entities", entity_id, domains, entity_globs, keep_days: keep_days ?? 0 };
      }
      await ha.callService("recorder", "purge", { data: defined({ keep_days, repack, apply_filter }) }, CAP);
      return { purged: "all", keep_days: keep_days ?? "recorder default", repack: repack ?? false };
    },
  );
}
