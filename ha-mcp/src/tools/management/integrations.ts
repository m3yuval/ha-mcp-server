import { z } from "zod";
import { HAError } from "../../ha-client.js";
import { DESTRUCTIVE, READ_ONLY, WRITE, defineTool, type ToolContext } from "../common.js";
import { CAP, defined, matches, need, pathId, presentFlowStep, ws, type FlowKind } from "./util.js";

interface ConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  source: string;
  state: string;
  disabled_by: string | null;
  reason?: string | null;
  supports_options?: boolean;
  supports_reconfigure?: boolean;
  supports_remove_device?: boolean;
  supports_unload?: boolean;
  pref_disable_new_entities?: boolean;
  pref_disable_polling?: boolean;
}

const FLOW_PATHS: Record<FlowKind, string> = {
  config: "/api/config/config_entries/flow",
  options: "/api/config/config_entries/options/flow",
  repair: "/api/repairs/issues/fix",
};

interface Description {
  name?: string;
  integration_type?: string;
  config_flow?: boolean;
  iot_class?: string;
  integrations?: Record<string, Description>;
}

/** Flatten integration/descriptions into one row per integration domain. */
function flattenDescriptions(res: any) {
  const rows = new Map<string, Record<string, unknown>>();
  const walk = (map: Record<string, Description> | undefined, source: string, group: string, brand?: string) => {
    for (const [domain, d] of Object.entries(map ?? {})) {
      if (!d || typeof d !== "object") continue;
      if (d.integrations && typeof d.integrations === "object") {
        walk(d.integrations, source, group, d.name ?? domain);
        continue;
      }
      if (rows.has(domain)) continue;
      rows.set(
        domain,
        defined({
          domain,
          name: d.name ?? domain,
          brand,
          type: d.integration_type ?? (group === "helper" ? "helper" : undefined),
          config_flow: d.config_flow ?? false,
          iot_class: d.iot_class,
          custom: source === "custom" ? true : undefined,
        }),
      );
    }
  };
  for (const source of ["core", "custom"]) {
    const s = res?.[source];
    if (!s) continue;
    walk(s.integration, source, "integration");
    walk(s.helper, source, "helper");
  }
  return [...rows.values()];
}

export function registerIntegrationTools(ctx: ToolContext) {
  const { ha } = ctx;

  defineTool(
    ctx,
    "ha_list_integrations",
    {
      title: "List installed integrations",
      description:
        "List configured integrations (config entries) with entry_id, domain, title, state (loaded, setup_error, setup_retry, not_loaded, ...), source, disabled_by and what they support (options, reconfigure). " +
        "Also lists discovered integrations waiting to be set up. Use entry_id with ha_manage_integration, ha_integration_flow and ha_get_integration_diagnostics.",
      inputSchema: {
        domain: z.string().optional().describe("Only this integration domain, e.g. 'hue'"),
        state: z.string().optional().describe("Only entries in this state, e.g. 'setup_error' or 'not_loaded'"),
        search: z.string().optional().describe("Substring matched against title and domain"),
        include_discovered: z.boolean().default(true).describe("Also list discovered/in-progress setup flows"),
      },
      annotations: READ_ONLY,
    },
    async ({ domain, state, search, include_discovered }) => {
      const entries = await ha.wsRead<ConfigEntry[]>("config_entries/get", defined({ domain }));
      const list = entries
        .filter((e) => (!state || e.state === state) && matches(search, e.title, e.domain))
        .map((e) =>
          defined({
            entry_id: e.entry_id,
            domain: e.domain,
            title: e.title,
            state: e.state,
            source: e.source,
            disabled_by: e.disabled_by,
            reason: e.reason ?? undefined,
            supports_options: e.supports_options,
            supports_reconfigure: e.supports_reconfigure,
            supports_remove_device: e.supports_remove_device,
          }),
        );
      if (!include_discovered) return { count: list.length, entries: list };
      let discovered: unknown[] = [];
      try {
        const flows = await ha.wsRead<any[]>("config_entries/flow/progress");
        discovered = flows
          .filter((f) => !domain || f.handler === domain)
          .map((f) => ({
            flow_id: f.flow_id,
            handler: f.handler,
            step_id: f.step_id,
            source: f.context?.source,
            title_placeholders: f.context?.title_placeholders,
          }));
      } catch {
        /* optional */
      }
      return { count: list.length, entries: list, discovered };
    },
  );

  defineTool(
    ctx,
    "ha_list_available_integrations",
    {
      title: "Find integrations to add",
      description:
        "Search the integrations Home Assistant can set up (built-in and custom). Returns domain, name, type (hub, device, service, helper, ...) and whether it can be added from the UI (config_flow). " +
        "To add one, call ha_integration_flow with action='start' and handler=<domain>. Integrations with config_flow=false are YAML-only.",
      inputSchema: {
        search: z.string().optional().describe("Substring matched against name and domain, e.g. 'mqtt' or 'weather'"),
        only_ui_setup: z.boolean().default(true).describe("Only integrations that can be set up from the UI"),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: READ_ONLY,
    },
    async ({ search, only_ui_setup, limit }) => {
      const res = await ha.wsRead<any>("integration/descriptions");
      const rows = flattenDescriptions(res)
        .filter((r) => (!only_ui_setup || r.config_flow) && matches(search, r.name, r.domain, r.brand))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { total: rows.length, integrations: rows.slice(0, limit) };
    },
  );

  defineTool(
    ctx,
    "ha_integration_flow",
    {
      title: "Add or configure an integration (setup wizard)",
      description:
        "Drive Home Assistant's setup wizards (data entry flows) step by step.\n" +
        "- flow='config' (default): add a new integration. action='start' with handler=<domain> (see ha_list_available_integrations). Pass entry_id too to start a reconfigure flow for an existing entry. Also used to continue a discovered flow (flow_id from ha_list_integrations).\n" +
        "- flow='options': change an integration's options. action='start' with handler=<entry_id>. The first form shows the current option values (current_value/default), so this is also how to read an integration's options; abort afterwards if nothing should change.\n" +
        "- flow='repair': fix a repair issue that is_fixable. action='start' with handler=<issue domain> and issue_id.\n" +
        "Each step returns type: 'form' (fields to fill: name, type, required, default, choices), 'menu' (pick a next_step_id), 'external' (user opens a URL), 'progress', 'create_entry' (done) or 'abort'. " +
        "Then action='step' with flow_id and user_input, action='get' to re-read the current step, action='abort' to cancel. action='list' shows flows in progress.",
      inputSchema: {
        action: z.enum(["start", "step", "get", "abort", "list"]),
        flow: z.enum(["config", "options", "repair"]).default("config"),
        handler: z.string().optional().describe("start: integration domain (config), config entry_id (options), or issue domain (repair)"),
        entry_id: z.string().optional().describe("start + flow='config': reconfigure this existing entry"),
        issue_id: z.string().optional().describe("start + flow='repair': the repair issue_id"),
        flow_id: z.string().optional().describe("step/get/abort: the flow_id returned by start"),
        user_input: z.record(z.any()).optional().describe("step: field values, e.g. {\"host\": \"192.168.1.10\"}; menus: {\"next_step_id\": \"...\"}"),
      },
      annotations: WRITE,
    },
    async ({ action, flow, handler, entry_id, issue_id, flow_id, user_input }) => {
      const kind = flow as FlowKind;
      const base = FLOW_PATHS[kind];
      if (action === "list") {
        if (kind !== "config") throw new HAError("action 'list' is only available for flow='config'");
        return ha.wsRead("config_entries/flow/progress");
      }
      if (action === "start") {
        need(handler, "handler", action);
        const body: Record<string, unknown> = { handler };
        if (kind === "config" && entry_id) body.entry_id = entry_id;
        if (kind === "repair") body.issue_id = need(issue_id, "issue_id", action);
        const step = await ha.post(base, body, CAP);
        return presentFlowStep(ha, kind, step);
      }
      const id = pathId(need(flow_id, "flow_id", action), "flow_id");
      if (action === "get") return presentFlowStep(ha, kind, await ha.get(`${base}/${id}`));
      if (action === "abort") {
        await ha.delete(`${base}/${id}`, CAP);
        return { aborted: true, flow_id };
      }
      const step = await ha.post(`${base}/${id}`, user_input ?? {}, CAP);
      return presentFlowStep(ha, kind, step);
    },
  );

  defineTool(
    ctx,
    "ha_manage_integration",
    {
      title: "Reload, enable, disable, rename or delete an integration",
      description:
        "Manage an installed integration (config entry) by entry_id (see ha_list_integrations).\n" +
        "- reload: reload the entry (fixes many setup_retry/setup_error states).\n" +
        "- disable / enable: disabling unloads it and its devices/entities until enabled again.\n" +
        "- update: change title, pref_disable_new_entities, pref_disable_polling.\n" +
        "- delete: remove the integration and all its devices and entities. Cannot be undone.\n" +
        "Options are changed with ha_integration_flow (flow='options').",
      inputSchema: {
        action: z.enum(["reload", "enable", "disable", "update", "delete"]),
        entry_id: z.string(),
        title: z.string().optional().describe("update: new title"),
        pref_disable_new_entities: z.boolean().optional().describe("update: don't add new entities automatically"),
        pref_disable_polling: z.boolean().optional().describe("update: disable polling for updates"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, entry_id, title, pref_disable_new_entities, pref_disable_polling }) => {
      const id = pathId(entry_id, "entry_id");
      switch (action) {
        case "reload":
          return ha.post(`/api/config/config_entries/entry/${id}/reload`, {}, CAP);
        case "delete":
          return ha.delete(`/api/config/config_entries/entry/${id}`, CAP);
        case "enable":
        case "disable":
          return ws(ha, "config_entries/disable", {
            entry_id,
            disabled_by: action === "disable" ? "user" : null,
          });
        case "update": {
          const changes = defined({ title, pref_disable_new_entities, pref_disable_polling });
          if (!Object.keys(changes).length) throw new HAError("Nothing to update: pass title or a pref_* field");
          return ws(ha, "config_entries/update", { entry_id, ...changes });
        }
      }
    },
  );

  defineTool(
    ctx,
    "ha_get_integration_diagnostics",
    {
      title: "Get integration diagnostics",
      description:
        "Download the diagnostics report of an integration (config entry), or of one of its devices when device_id is given. " +
        "Not every integration supports diagnostics. Sensitive values are redacted by Home Assistant. Useful for debugging.",
      inputSchema: {
        entry_id: z.string(),
        device_id: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ entry_id, device_id }) => {
      let path = `/api/diagnostics/config_entry/${pathId(entry_id, "entry_id")}`;
      if (device_id) path += `/device/${pathId(device_id, "device_id")}`;
      return ha.get(path);
    },
  );
}
