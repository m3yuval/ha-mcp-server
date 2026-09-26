/**
 * Supervisor management: add-ons, store, backups, jobs, core, Supervisor, OS,
 * host and the resolution center (capability: management, add-on only).
 *
 * All calls go through ha.supervisor(). Paths are the Supervisor "v1" API
 * (the default; /v2 is behind a feature flag). Endpoints and payloads were
 * checked against supervisor/api/__init__.py and the handler modules in
 * github.com/home-assistant/supervisor. Every endpoint used here is allowed for
 * an add-on with hassio_role "manager" (supervisor/api/middleware/security.py).
 *
 * Safety:
 *   - Destroying/replacing data (uninstall, remove/restore backup, stop/restart
 *     core, host reboot/shutdown, remove repository, apply suggestion) needs
 *     confirm: true. Without it nothing is sent.
 *   - This add-on never stops, restarts, updates, uninstalls or reconfigures
 *     itself (detected via GET /addons/self/info).
 *   - Long operations (backup, restore, install, update) run in the
 *     Supervisor's background mode and return a job id for ha_get_job.
 */
import { z } from "zod";
import { HAError } from "../ha-client.js";
import { defineTool, DESTRUCTIVE, READ_ONLY, WRITE, type ToolContext } from "./common.js";

// Supervisor slugs: RE_SLUG in supervisor/const.py is [-_.A-Za-z0-9]+.
const SLUG = /^[-_.A-Za-z0-9]+$/;
const HEX_ID = /^[a-f0-9]{8,64}$/i;
const VERSION = /^[A-Za-z0-9][-_.+A-Za-z0-9]*$/;
const SECRET_KEY = /token|password|passwd|secret|api_?key|authorization|credential/i;

const BACKUP_FOLDERS = ["share", "addons/local", "ssl", "media"] as const;
const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 5000;

const slugArg = (what: string) => z.string().regex(SLUG, `invalid ${what} slug`);
const confirmArg = z
  .boolean()
  .optional()
  .describe("Must be true. Ask the user for explicit confirmation before setting it.");

function requireConfirm(args: { confirm?: boolean }, what: string) {
  if (args.confirm !== true) {
    throw new HAError(
      `Refusing to ${what} without confirm: true. Explain the impact to the user, get their explicit approval, then call again with confirm: true.`,
    );
  }
}

/** Network-level failure (timeout / connection closed) as opposed to an API error. */
function isNoResponse(err: unknown) {
  return (
    err instanceof HAError &&
    err.status === undefined &&
    /abort|timeout|timed out|fetch failed|socket|ECONNRESET|terminated|other side closed/i.test(err.message)
  );
}

/**
 * Run a call that may take longer than the client timeout, or that may cut
 * the connection (host reboot, Supervisor update). A missing response is not
 * treated as a failure: the Supervisor keeps going on its own.
 */
async function longOp<T>(what: string, followUp: string, fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (err) {
    if (isNoResponse(err)) {
      return (
        `${what}: no response before the request timed out or the connection closed. ` +
        `This is expected for long or disruptive operations; the Supervisor most likely continues in the background. ${followUp}`
      );
    }
    throw err;
  }
}

/** Mask values of secret-looking keys (for displaying add-on options). */
function maskSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && val !== null && val !== "" && typeof val !== "object" ? "***" : maskSecrets(val);
    }
    return out;
  }
  return v;
}

function pick(obj: Record<string, any> | undefined, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Normalize a background-capable response. */
function jobResult(res: any, what: string) {
  if (res && typeof res === "object" && res.job_id) {
    return {
      status: "started",
      job_id: res.job_id,
      ...(res.slug ? { slug: res.slug } : {}),
      message: `${what} started in the background. Poll ha_get_job with job_id until done is true, and check its errors.`,
    };
  }
  return { status: "done", message: `${what} completed.`, ...(res && typeof res === "object" ? res : {}) };
}

export function registerSupervisorTools(ctx: ToolContext) {
  const { ha } = ctx;
  const sup = <T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) =>
    ha.supervisor<T>(method, path, body);

  // ------------------------------------------------------------- self guard
  let selfSlug: Promise<string> | undefined;
  const getSelfSlug = () => {
    if (!selfSlug) {
      selfSlug = sup<{ slug: string }>("GET", "/addons/self/info").then((i) => {
        if (!i?.slug) throw new HAError("Supervisor did not return this add-on's slug");
        return i.slug;
      });
      selfSlug.catch(() => (selfSlug = undefined));
    }
    return selfSlug;
  };
  async function assertNotSelf(slug: string, what: string) {
    let own: string;
    try {
      own = await getSelfSlug();
    } catch (err) {
      throw new HAError(
        `Refusing to ${what} '${slug}': could not determine this add-on's own slug (${(err as Error).message}).`,
      );
    }
    if (slug === "self" || slug === own) {
      throw new HAError(
        `Refusing to ${what} '${own}': that is this add-on, which runs the MCP server you are talking to. ` +
          `Doing it from here would cut off this connection mid-operation or let the assistant change its own permissions. ` +
          `The user can do it from the Home Assistant UI (Settings > Add-ons).`,
      );
    }
  }

  // --------------------------------------------------------------- overview
  defineTool(
    ctx,
    "ha_system_overview",
    {
      title: "System overview",
      description:
        "One-shot health summary of the Home Assistant installation: versions of Core, Supervisor and OS, available updates " +
        "(Core/Supervisor/OS/add-ons), add-on counts, and resolution-center issues/unhealthy/unsupported flags. Start here.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const paths = {
        info: "/info",
        core: "/core/info",
        supervisor: "/supervisor/info",
        os: "/os/info",
        updates: "/available_updates",
        addons: "/addons",
        resolution: "/resolution/info",
      } as const;
      const keys = Object.keys(paths) as (keyof typeof paths)[];
      const settled = await Promise.allSettled(keys.map((k) => sup("GET", paths[k])));
      const r: Record<string, any> = {};
      const errors: Record<string, string> = {};
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") r[keys[i]] = s.value;
        else errors[keys[i]] = (s.reason as Error)?.message ?? String(s.reason);
      });
      const addons: any[] = r.addons?.addons ?? [];
      const updates: any[] = r.updates?.available_updates ?? [];
      return {
        system: pick(r.info, ["hostname", "operating_system", "machine", "arch", "state", "supported", "channel", "timezone", "docker"]),
        core: pick(r.core, ["version", "version_latest", "update_available", "boot", "watchdog", "port", "ssl"]),
        supervisor: pick(r.supervisor, ["version", "version_latest", "update_available", "channel", "healthy", "supported", "auto_update"]),
        os: pick(r.os, ["version", "version_latest", "update_available", "board", "boot"]),
        updates_available: updates.map((u) => pick(u, ["update_type", "name", "version_latest"])),
        addons: r.addons
          ? {
              installed: addons.length,
              started: addons.filter((a) => a.state === "started").length,
              updates_available: addons.filter((a) => a.update_available).map((a) => a.slug),
            }
          : undefined,
        resolution: r.resolution
          ? {
              issues: (r.resolution.issues ?? []).length,
              suggestions: (r.resolution.suggestions ?? []).length,
              unhealthy: r.resolution.unhealthy ?? [],
              unsupported: r.resolution.unsupported ?? [],
            }
          : undefined,
        ...(Object.keys(errors).length ? { errors } : {}),
      };
    },
  );

  const INFO_PATHS = {
    core: "/core/info",
    supervisor: "/supervisor/info",
    os: "/os/info",
    host: "/host/info",
    network: "/network/info",
    resolution: "/resolution/info",
    updates: "/available_updates",
    system: "/info",
  } as const;

  defineTool(
    ctx,
    "ha_get_system_info",
    {
      title: "System component info",
      description:
        "Detailed info for one component: core (Home Assistant Core container), supervisor, os (Home Assistant OS, boot slots), " +
        "host (hostname, kernel, disk usage, uptime), network (interfaces, IPs, Wi-Fi), resolution (resolution-center issues, " +
        "suggestions with their uuids, unhealthy/unsupported reasons), updates (all available updates), system (/info summary).",
      inputSchema: {
        component: z.enum(Object.keys(INFO_PATHS) as [keyof typeof INFO_PATHS, ...(keyof typeof INFO_PATHS)[]]),
      },
      annotations: READ_ONLY,
    },
    async ({ component }) => sup("GET", INFO_PATHS[component as keyof typeof INFO_PATHS]),
  );

  // -------------------------------------------------------------------- logs
  defineTool(
    ctx,
    "ha_get_logs",
    {
      title: "Get logs",
      description:
        "Tail the systemd-journal logs of Home Assistant Core, the Supervisor, the host, or an add-on (source: addon + slug). " +
        "Returns plain text, newest lines last.",
      inputSchema: {
        source: z.enum(["core", "supervisor", "host", "addon"]),
        slug: slugArg("add-on").optional().describe("Add-on slug (required when source is addon)"),
        lines: z.number().int().min(2).max(MAX_LOG_LINES).optional().describe(`Lines to return (default ${DEFAULT_LOG_LINES})`),
      },
      annotations: READ_ONLY,
    },
    async ({ source, slug, lines }) => {
      let base: string;
      if (source === "addon") {
        if (!slug) throw new HAError("slug is required when source is 'addon'");
        base = `/addons/${slug}`;
      } else {
        base = `/${source}`;
      }
      const n = lines ?? DEFAULT_LOG_LINES;
      const out = await sup<unknown>("GET", `${base}/logs?lines=${n}&no_colors`);
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return text.trim() ? text : "(no log lines)";
    },
  );

  // ------------------------------------------------------------------ add-ons
  defineTool(
    ctx,
    "ha_list_addons",
    {
      title: "List add-ons",
      description:
        "source=installed (default): installed add-ons with version, latest version, update flag, state and repository. " +
        "source=store: add-ons available in the add-on store (filter with query/repository), plus the list of store repositories.",
      inputSchema: {
        source: z.enum(["installed", "store"]).optional(),
        query: z.string().optional().describe("Case-insensitive match on name, slug or description"),
        repository: z.string().optional().describe("Only add-ons from this repository slug (e.g. core, local)"),
        limit: z.number().int().min(1).max(500).optional().describe("Max add-ons returned (default 100)"),
      },
      annotations: READ_ONLY,
    },
    async ({ source, query, repository, limit }) => {
      const q = query?.toLowerCase();
      const match = (a: any) =>
        (!q || [a.name, a.slug, a.description].some((s) => typeof s === "string" && s.toLowerCase().includes(q))) &&
        (!repository || a.repository === repository);
      const max = limit ?? 100;
      if (source === "store") {
        const store = await sup<{ addons?: any[]; repositories?: any[] }>("GET", "/store");
        const all = (store.addons ?? []).filter(match);
        return {
          total: all.length,
          addons: all
            .slice(0, max)
            .map((a) => pick(a, ["name", "slug", "description", "repository", "version_latest", "installed", "version", "update_available", "available", "stage"])),
          repositories: (store.repositories ?? []).map((r) => pick(r, ["slug", "name", "source", "url", "maintainer"])),
        };
      }
      const res = await sup<{ addons?: any[] }>("GET", "/addons");
      const all = (res.addons ?? []).filter(match);
      return {
        total: all.length,
        addons: all
          .slice(0, max)
          .map((a) => pick(a, ["name", "slug", "version", "version_latest", "update_available", "state", "repository", "available"])),
      };
    },
  );

  defineTool(
    ctx,
    "ha_addon_info",
    {
      title: "Add-on info",
      description:
        "Details of one add-on: state, versions, options (secret-looking values masked) and options schema, ports/network, " +
        "boot/auto_update/watchdog, ingress/web UI, API roles. Works for store add-ons that are not installed too. " +
        "Use ha_get_logs (source: addon) for its logs.",
      inputSchema: { slug: slugArg("add-on") },
      annotations: READ_ONLY,
    },
    async ({ slug }) => {
      const i = await sup<Record<string, any>>("GET", `/addons/${slug}/info`);
      return {
        ...pick(i, [
          "name", "slug", "description", "state", "version", "version_latest", "update_available", "repository", "url",
          "stage", "boot", "auto_update", "watchdog", "protected", "rating", "startup",
          "network", "network_description", "host_network", "ingress", "ingress_panel", "webui", "ip_address",
          "hassio_api", "hassio_role", "homeassistant_api", "auth_api", "full_access", "privileged", "available", "detached",
        ]),
        options: maskSecrets(i.options),
        schema: i.schema,
        logs_hint: `Use ha_get_logs with source 'addon' and slug '${slug}'.`,
      };
    },
  );

  defineTool(
    ctx,
    "ha_addon_control",
    {
      title: "Start / stop / restart add-on",
      description:
        "Start, stop or restart an installed add-on. Refuses to stop or restart this MCP add-on itself. " +
        "Start/restart wait for the add-on to come up and may time out on slow add-ons while the Supervisor continues.",
      inputSchema: { slug: slugArg("add-on"), action: z.enum(["start", "stop", "restart"]) },
      annotations: WRITE,
    },
    async ({ slug, action }) => {
      if (action !== "start") await assertNotSelf(slug, action);
      const r = await longOp(`Add-on ${action} of '${slug}'`, "Check its state with ha_addon_info.", () =>
        sup("POST", `/addons/${slug}/${action}`),
      );
      return typeof r === "string" ? r : `Add-on '${slug}': ${action} OK.`;
    },
  );

  defineTool(
    ctx,
    "ha_addon_install",
    {
      title: "Install add-on",
      description:
        "Install an add-on from the store (find slugs with ha_list_addons source=store; add third-party repositories with " +
        "ha_store_repository). Runs in the background and returns a job id for ha_get_job. Installed add-ons get their own " +
        "access to the system, so confirm the choice with the user.",
      inputSchema: {
        slug: slugArg("add-on"),
        version: z.string().regex(VERSION).optional().describe("Specific version (default: latest)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ slug, version }) => {
      const path = `/store/addons/${slug}/install${version ? `/${version}` : ""}`;
      const r = await longOp(`Install of '${slug}'`, "Check ha_get_job (no id: lists recent jobs) or ha_addon_info.", () =>
        sup("POST", path, { background: true }),
      );
      return typeof r === "string" ? r : jobResult(r, `Install of add-on '${slug}'`);
    },
  );

  defineTool(
    ctx,
    "ha_addon_uninstall",
    {
      title: "Uninstall add-on",
      description:
        "Uninstall an add-on. Its data is lost unless it is in a backup; remove_config also deletes its config folder. " +
        "Requires confirm: true. Refuses to uninstall this MCP add-on itself.",
      inputSchema: {
        slug: slugArg("add-on"),
        remove_config: z.boolean().optional().describe("Also delete the add-on's public config folder (default false)"),
        confirm: confirmArg,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ slug, remove_config, confirm }) => {
      requireConfirm({ confirm }, `uninstall add-on '${slug}'`);
      await assertNotSelf(slug, "uninstall");
      await sup("POST", `/addons/${slug}/uninstall`, { remove_config: remove_config ?? false });
      return `Add-on '${slug}' uninstalled.`;
    },
  );

  defineTool(
    ctx,
    "ha_addon_set_options",
    {
      title: "Set add-on options",
      description:
        "Change an add-on's configuration. options are merged into the current options (merge: false replaces them), " +
        "validated with the add-on's schema first (nothing is saved if invalid), then saved. Also sets boot/auto_update/watchdog. " +
        "Options take effect after a restart (restart: true does it). Refuses to change this MCP add-on itself.",
      inputSchema: {
        slug: slugArg("add-on"),
        options: z.record(z.unknown()).optional().describe("Add-on options (see ha_addon_info schema)"),
        merge: z.boolean().optional().describe("Merge into current options (default true)"),
        boot: z.enum(["auto", "manual"]).optional(),
        auto_update: z.boolean().optional(),
        watchdog: z.boolean().optional(),
        restart: z.boolean().optional().describe("Restart the add-on afterwards to apply (default false)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ slug, options, merge, boot, auto_update, watchdog, restart }) => {
      await assertNotSelf(slug, "change the options of");
      const body: Record<string, unknown> = {};
      if (options) {
        let next = options as Record<string, unknown>;
        if (merge !== false) {
          const info = await sup<Record<string, any>>("GET", `/addons/${slug}/info`);
          next = { ...(info.options ?? {}), ...next };
        }
        const v = await sup<{ valid: boolean; message?: string; pwned?: boolean | null }>(
          "POST",
          `/addons/${slug}/options/validate`,
          next,
        );
        if (!v?.valid) throw new HAError(`Options are invalid, nothing was saved: ${v?.message || "unknown validation error"}`);
        body.options = next;
      }
      if (boot !== undefined) body.boot = boot;
      if (auto_update !== undefined) body.auto_update = auto_update;
      if (watchdog !== undefined) body.watchdog = watchdog;
      if (!Object.keys(body).length) throw new HAError("Nothing to change: pass options, boot, auto_update or watchdog");
      await sup("POST", `/addons/${slug}/options`, body);
      if (restart) {
        const r = await longOp(`Restart of '${slug}'`, "Check its state with ha_addon_info.", () =>
          sup("POST", `/addons/${slug}/restart`),
        );
        return typeof r === "string" ? `Options saved. ${r}` : `Options saved and add-on '${slug}' restarted.`;
      }
      return `Options saved for '${slug}'.${body.options ? " Restart the add-on to apply them." : ""}`;
    },
  );

  // -------------------------------------------------------------------- store
  defineTool(
    ctx,
    "ha_store_repository",
    {
      title: "Add / remove add-on repository",
      description:
        "Add a third-party add-on repository by URL (e.g. a GitHub repo URL), or remove one by slug (see ha_list_addons " +
        "source=store). Third-party add-ons are not reviewed by Home Assistant: confirm with the user. Remove requires confirm: true " +
        "and fails while add-ons from it are installed.",
      inputSchema: {
        action: z.enum(["add", "remove"]),
        repository: z.string().min(1).describe("add: repository URL; remove: repository slug"),
        confirm: confirmArg,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, repository, confirm }) => {
      if (action === "add") {
        if (!/^(https?:\/\/|git@)\S+$/.test(repository)) throw new HAError("repository must be a URL");
        const r = await longOp(`Adding repository`, "Check ha_list_addons source=store.", () =>
          sup("POST", "/store/repositories", { repository }),
        );
        return typeof r === "string" ? r : `Repository added: ${repository}`;
      }
      if (!SLUG.test(repository)) throw new HAError("remove expects the repository slug (see ha_list_addons source=store)");
      requireConfirm({ confirm }, `remove repository '${repository}'`);
      await sup("DELETE", `/store/repositories/${repository}`);
      return `Repository '${repository}' removed.`;
    },
  );

  // ------------------------------------------------------------------ backups
  defineTool(
    ctx,
    "ha_list_backups",
    {
      title: "List backups",
      description: "List backups (newest first) or, with slug, details of one backup (add-ons, folders, versions, locations).",
      inputSchema: { slug: slugArg("backup").optional() },
      annotations: READ_ONLY,
    },
    async ({ slug }) => {
      if (slug) return sup("GET", `/backups/${slug}/info`);
      const res = await sup<{ backups?: any[]; days_until_stale?: number }>("GET", "/backups/info");
      const list = [...(res.backups ?? [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return {
        count: list.length,
        days_until_stale: res.days_until_stale,
        backups: list.map((b) => pick(b, ["slug", "name", "date", "type", "size", "protected", "compressed", "location", "locations", "content"])),
      };
    },
  );

  const partialShape = {
    homeassistant: z.boolean().optional().describe("Partial: include Home Assistant config"),
    addons: z
      .union([z.literal("ALL"), z.array(slugArg("add-on"))])
      .optional()
      .describe('Partial: add-on slugs, or "ALL"'),
    folders: z.array(z.enum(BACKUP_FOLDERS)).optional().describe("Partial: folders"),
  };

  defineTool(
    ctx,
    "ha_create_backup",
    {
      title: "Create backup",
      description:
        "Create a backup. Full by default; pass homeassistant/addons/folders for a partial backup. Optional password " +
        "encrypts it (it is never logged; the user must keep it to restore). Runs in the background and returns a job id: " +
        "poll ha_get_job; when done, the job reference is the backup slug.",
      inputSchema: {
        name: z.string().max(200).optional(),
        password: z.string().min(1).optional(),
        ...partialShape,
        homeassistant_exclude_database: z.boolean().optional().describe("Skip the recorder database (smaller)"),
        compressed: z.boolean().optional(),
        location: z.array(z.string()).optional().describe("Backup mount names; omit for local storage"),
      },
      annotations: WRITE,
    },
    async (args) => {
      const partial = args.homeassistant !== undefined || args.addons !== undefined || args.folders !== undefined;
      const body: Record<string, unknown> = { background: true };
      for (const k of ["name", "password", "homeassistant_exclude_database", "compressed", "location"] as const) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      if (partial) {
        for (const k of ["homeassistant", "addons", "folders"] as const) if (args[k] !== undefined) body[k] = args[k];
      }
      const path = partial ? "/backups/new/partial" : "/backups/new/full";
      const r = await longOp("Backup", "Check ha_get_job (no id lists recent jobs) or ha_list_backups.", () =>
        sup("POST", path, body),
      );
      return typeof r === "string" ? r : jobResult(r, `${partial ? "Partial" : "Full"} backup`);
    },
  );

  defineTool(
    ctx,
    "ha_remove_backup",
    {
      title: "Delete backup",
      description: "Permanently delete a backup. Requires confirm: true.",
      inputSchema: { slug: slugArg("backup"), confirm: confirmArg },
      annotations: DESTRUCTIVE,
    },
    async ({ slug, confirm }) => {
      requireConfirm({ confirm }, `delete backup '${slug}'`);
      await sup("DELETE", `/backups/${slug}`);
      return `Backup '${slug}' deleted.`;
    },
  );

  defineTool(
    ctx,
    "ha_restore_backup",
    {
      title: "Restore backup",
      description:
        "Restore a backup, overwriting current data. Full restore by default (replaces Home Assistant config and all add-ons, " +
        "then restarts Home Assistant; this MCP server and its tools go offline for a while). Pass homeassistant/addons/folders " +
        "for a partial restore. password is needed for protected backups. Requires confirm: true. Returns a job id.",
      inputSchema: {
        slug: slugArg("backup"),
        password: z.string().min(1).optional(),
        ...partialShape,
        addons: z.array(slugArg("add-on")).optional().describe("Partial: add-on slugs to restore"),
        confirm: confirmArg,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      requireConfirm(args, `restore backup '${args.slug}'`);
      const partial = args.homeassistant !== undefined || args.addons !== undefined || args.folders !== undefined;
      const body: Record<string, unknown> = { background: true };
      if (args.password !== undefined) body.password = args.password;
      if (partial) {
        for (const k of ["homeassistant", "addons", "folders"] as const) if (args[k] !== undefined) body[k] = args[k];
      }
      const path = `/backups/${args.slug}/restore/${partial ? "partial" : "full"}`;
      const r = await longOp(
        "Restore",
        "Home Assistant restarts during a restore; wait a few minutes, then check ha_get_job or ha_system_overview.",
        () => sup("POST", path, body),
      );
      return typeof r === "string" ? r : jobResult(r, `${partial ? "Partial" : "Full"} restore of '${args.slug}'`);
    },
  );

  // --------------------------------------------------------------------- jobs
  defineTool(
    ctx,
    "ha_get_job",
    {
      title: "Get Supervisor job",
      description:
        "Progress of a background Supervisor job (backup, restore, install, update) by job_id: progress, stage, done, errors, " +
        "reference. Without job_id, lists recent jobs (newest first).",
      inputSchema: {
        job_id: z.string().regex(HEX_ID, "invalid job id").optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Jobs listed without job_id (default 20)"),
      },
      annotations: READ_ONLY,
    },
    async ({ job_id, limit }) => {
      if (job_id) return sup("GET", `/jobs/${job_id}`);
      const res = await sup<{ jobs?: any[] }>("GET", "/jobs/info");
      return (res.jobs ?? []).slice(0, limit ?? 20);
    },
  );

  // ------------------------------------------------------------------ updates
  defineTool(
    ctx,
    "ha_update",
    {
      title: "Update component",
      description:
        "Update Home Assistant Core, an add-on (target addon + slug), the Supervisor, or Home Assistant OS. Updates can " +
        "break things: backup (core/addon only, default true) makes a backup first. Core and add-on updates run in the " +
        "background (job id for ha_get_job). Supervisor updates restart the Supervisor; OS updates reboot the host, so " +
        "the call may end without a response. Refuses to update this MCP add-on itself.",
      inputSchema: {
        target: z.enum(["core", "addon", "supervisor", "os"]),
        slug: slugArg("add-on").optional().describe("Add-on slug (target addon)"),
        version: z.string().regex(VERSION).optional().describe("Specific version (default: latest)"),
        backup: z.boolean().optional().describe("Back up before updating (core/addon; default true)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ target, slug, version, backup }) => {
      const doBackup = backup ?? true;
      if (target === "addon") {
        if (!slug) throw new HAError("slug is required when target is 'addon'");
        await assertNotSelf(slug, "update");
        const path = `/store/addons/${slug}/update${version ? `/${version}` : ""}`;
        const r = await longOp(`Update of '${slug}'`, "Check ha_get_job or ha_addon_info.", () =>
          sup("POST", path, { backup: doBackup, background: true }),
        );
        return typeof r === "string" ? r : jobResult(r, `Update of add-on '${slug}'`);
      }
      if (target === "core") {
        const body: Record<string, unknown> = { backup: doBackup, background: true };
        if (version) body.version = version;
        const r = await longOp("Core update", "Check ha_get_job or ha_system_overview.", () => sup("POST", "/core/update", body));
        return typeof r === "string" ? r : jobResult(r, "Home Assistant Core update");
      }
      if (backup) throw new HAError(`backup is not supported for target '${target}'; create one with ha_create_backup first`);
      const body = version ? { version } : {};
      const follow =
        target === "os"
          ? "The host reboots when the OS update is installed; check ha_system_overview in a few minutes."
          : "The Supervisor restarts itself; check ha_system_overview in a minute.";
      const r = await longOp(`${target === "os" ? "OS" : "Supervisor"} update`, follow, () => sup("POST", `/${target}/update`, body));
      return typeof r === "string" ? r : `${target === "os" ? "OS" : "Supervisor"} update done. ${follow}`;
    },
  );

  // --------------------------------------------------------------------- core
  defineTool(
    ctx,
    "ha_core_check_config",
    {
      title: "Check Core configuration",
      description:
        "Validate the Home Assistant configuration (configuration.yaml and includes) without restarting. " +
        "Returns 'valid' or the errors. Run this before restarting Core after config changes.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        await sup("POST", "/core/check");
        return { valid: true };
      } catch (err) {
        if (err instanceof HAError && err.status === 400) {
          let msg = err.message;
          const m = msg.match(/\{.*\}$/s);
          if (m) {
            try {
              msg = JSON.parse(m[0]).message ?? msg;
            } catch {
              /* keep raw */
            }
          }
          return { valid: false, errors: msg };
        }
        throw err;
      }
    },
  );

  defineTool(
    ctx,
    "ha_core_control",
    {
      title: "Restart / stop / rebuild / start Core",
      description:
        "Control the Home Assistant Core container. restart (optionally safe_mode: no custom integrations), stop, rebuild " +
        "(recreate the container) need confirm: true: Core, and every Home Assistant tool of this server, is unavailable " +
        "until it is back (usually 1-3 minutes). start needs no confirm. Run ha_core_check_config before a restart. " +
        "force skips the offline-database-migration guard (not recommended).",
      inputSchema: {
        action: z.enum(["restart", "stop", "rebuild", "start"]),
        safe_mode: z.boolean().optional().describe("restart/rebuild: start in safe mode"),
        force: z.boolean().optional(),
        confirm: confirmArg,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, safe_mode, force, confirm }) => {
      if (action !== "start") requireConfirm({ confirm }, `${action} Home Assistant Core`);
      const body: Record<string, unknown> = {};
      if (safe_mode !== undefined && (action === "restart" || action === "rebuild")) body.safe_mode = safe_mode;
      if (force !== undefined && action !== "start") body.force = force;
      const r = await longOp(`Core ${action}`, "Check ha_system_overview (core state) in a minute.", () =>
        sup("POST", `/core/${action}`, action === "start" ? undefined : body),
      );
      return typeof r === "string" ? r : `Home Assistant Core: ${action} OK.`;
    },
  );

  // --------------------------------------------------------------------- host
  defineTool(
    ctx,
    "ha_host_power",
    {
      title: "Reboot / shut down host",
      description:
        "Reboot or shut down the machine running Home Assistant. Everything goes offline, including this server. After " +
        "shutdown someone must power the machine on physically. Requires confirm: true. force skips the " +
        "offline-database-migration guard (not recommended).",
      inputSchema: { action: z.enum(["reboot", "shutdown"]), force: z.boolean().optional(), confirm: confirmArg },
      annotations: DESTRUCTIVE,
    },
    async ({ action, force, confirm }) => {
      requireConfirm({ confirm }, `${action} the host`);
      const r = await longOp(`Host ${action}`, "", () => sup("POST", `/host/${action}`, force ? { force: true } : {}));
      return typeof r === "string" ? r : `Host ${action} requested.`;
    },
  );

  // --------------------------------------------------------------- resolution
  defineTool(
    ctx,
    "ha_resolution_action",
    {
      title: "Apply / dismiss repair suggestion",
      description:
        "Act on the Supervisor resolution center (list with ha_get_system_info component=resolution). apply_suggestion runs " +
        "the suggested fix (some fixes delete data, e.g. clear_full_backup, or restart things) and requires confirm: true. " +
        "dismiss_suggestion / dismiss_issue just hide the item.",
      inputSchema: {
        action: z.enum(["apply_suggestion", "dismiss_suggestion", "dismiss_issue"]),
        uuid: z.string().regex(HEX_ID, "invalid uuid"),
        confirm: confirmArg,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, uuid, confirm }) => {
      if (action === "apply_suggestion") {
        requireConfirm({ confirm }, `apply suggestion ${uuid}`);
        const r = await longOp("Applying suggestion", "Check ha_get_system_info component=resolution.", () =>
          sup("POST", `/resolution/suggestion/${uuid}`),
        );
        return typeof r === "string" ? r : `Suggestion ${uuid} applied.`;
      }
      const kind = action === "dismiss_issue" ? "issue" : "suggestion";
      await sup("DELETE", `/resolution/${kind}/${uuid}`);
      return `${kind === "issue" ? "Issue" : "Suggestion"} ${uuid} dismissed.`;
    },
  );
}
