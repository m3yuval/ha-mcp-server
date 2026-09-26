import { z } from "zod";
import { HAError, type HAClient } from "../../ha-client.js";
import { DESTRUCTIVE, READ_ONLY, defineTool, type HAState, type ToolContext } from "../common.js";
import { CAP, defined, matches, need, pathId, slugify, ws } from "./util.js";

const KIND = z.enum(["automation", "script", "scene"]).describe("automation, script or scene");
type Kind = "automation" | "script" | "scene";

const configPath = (kind: Kind, id: string) => `/api/config/${kind}/config/${pathId(id, `${kind} id`)}`;

async function exists(ha: HAClient, kind: Kind, id: string) {
  try {
    await ha.get(configPath(kind, id));
    return true;
  } catch (err) {
    if ((err as HAError).status === 404) return false;
    throw err;
  }
}

/**
 * Validate triggers/conditions/actions with the validate_config websocket
 * command. Returns only the parts that were checked.
 */
async function validate(ha: HAClient, kind: Kind, config: Record<string, any>) {
  if (kind === "scene" || config.use_blueprint) return null;
  const payload: Record<string, unknown> = {};
  if (kind === "automation") {
    const triggers = config.triggers ?? config.trigger;
    const conditions = config.conditions ?? config.condition;
    const actions = config.actions ?? config.action;
    if (triggers !== undefined) payload.triggers = triggers;
    if (conditions !== undefined) payload.conditions = conditions;
    if (actions !== undefined) payload.actions = actions;
  } else if (config.sequence !== undefined) {
    payload.actions = config.sequence;
  }
  if (!Object.keys(payload).length) return null;
  return ws<Record<string, { valid: boolean; error: string | null }>>(ha, "validate_config", payload);
}

/** Compact a trace step map: path -> [{timestamp, result, error}]. */
function compactTrace(trace: Record<string, any[]> | undefined) {
  if (!trace) return undefined;
  const out: Record<string, unknown> = {};
  for (const [path, steps] of Object.entries(trace)) {
    out[path] = (steps ?? []).map((s: any) =>
      defined({
        timestamp: s.timestamp,
        result: s.result,
        error: s.error,
        changed_variables: s.changed_variables && Object.keys(s.changed_variables).length ? s.changed_variables : undefined,
      }),
    );
  }
  return out;
}

export function registerAutomationTools(ctx: ToolContext) {
  const { ha } = ctx;

  defineTool(
    ctx,
    "ha_list_automation_configs",
    {
      title: "List automations, scripts or scenes",
      description:
        "List automations, scripts or scenes with their entity_id, name, state and config id. " +
        "Items with editable=true are stored in the UI config (automations.yaml / scripts.yaml / scenes.yaml) and can be read and changed with ha_get_automation_config / ha_save_automation_config using the id.",
      inputSchema: {
        kind: KIND,
        search: z.string().optional().describe("Substring matched against entity_id, name and id"),
      },
      annotations: READ_ONLY,
    },
    async ({ kind, search }) => {
      const [states, registry] = await Promise.all([
        ha.get<HAState[]>("/api/states"),
        ha.wsRead<any[]>("config/entity_registry/list").catch(() => [] as any[]),
      ]);
      const uniqueIds = new Map(registry.map((e) => [e.entity_id, e.unique_id]));
      const rows = states
        .filter((s) => s.entity_id.startsWith(`${kind}.`))
        .map((s) => {
          const a = s.attributes ?? {};
          let id: unknown = a.id;
          if (kind === "script") id = uniqueIds.get(s.entity_id) ?? s.entity_id.slice("script.".length);
          return defined({
            entity_id: s.entity_id,
            id: id ?? undefined,
            name: a.friendly_name,
            state: s.state,
            last_triggered: a.last_triggered ?? undefined,
            mode: a.mode ?? undefined,
            editable: id !== undefined && id !== null,
          });
        })
        .filter((r) => matches(search, r.entity_id, r.name, r.id));
      return { count: rows.length, items: rows };
    },
  );

  defineTool(
    ctx,
    "ha_get_automation_config",
    {
      title: "Get automation, script or scene config",
      description:
        "Get the stored configuration of a UI-managed automation, script or scene by its config id (from ha_list_automation_configs; for scripts this is the key, usually the part after 'script.').",
      inputSchema: { kind: KIND, id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ kind, id }) => ha.get(configPath(kind, id)),
  );

  defineTool(
    ctx,
    "ha_save_automation_config",
    {
      title: "Create or update an automation, script or scene",
      description:
        "Create or replace a UI-managed automation, script or scene, then reload it. Without id a new one is created (automation/scene: a numeric id; script: a slug of the alias). With id the existing config is REPLACED entirely — fetch it first with ha_get_automation_config and send the full edited config.\n" +
        "Automation config: {alias, description, mode, triggers: [...], conditions: [...], actions: [...]}. Script: {alias, description, mode, fields, sequence: [...]}. Scene: {name, entities: {entity_id: state_or_attributes}}.\n" +
        "From a blueprint: {alias, use_blueprint: {path: 'author/file.yaml', input: {...}}} (see ha_list_blueprints).\n" +
        "Triggers/conditions/actions are validated first; if invalid nothing is saved and the errors are returned. validate_only=true only checks.",
      inputSchema: {
        kind: KIND,
        id: z.string().optional().describe("Config id to update; omit to create a new one"),
        config: z.record(z.any()).describe("The full configuration"),
        validate_only: z.boolean().default(false),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ kind, id, config, validate_only }) => {
      const validation = await validate(ha, kind, config);
      const invalid = validation && Object.values(validation).some((v) => v && v.valid === false);
      if (invalid || validate_only) {
        return { saved: false, valid: !invalid, validation: validation ?? "no triggers/conditions/actions to validate" };
      }
      let key = id;
      let existed = false;
      if (key) {
        existed = await exists(ha, kind, key);
      } else if (kind === "script") {
        const base = slugify(String(config.alias ?? "script"));
        key = base;
        for (let i = 2; await exists(ha, kind, key); i++) key = `${base}_${i}`;
      } else {
        key = String(Date.now());
      }
      // Home Assistant sets the id from the URL; a different id in the body would override it.
      const { id: _ignored, ...body } = config as Record<string, unknown>;
      await ha.post(configPath(kind, key), body, CAP);
      return defined({
        saved: true,
        created: !existed,
        kind,
        id: key,
        entity_id: kind === "script" ? `script.${key}` : undefined,
        validation: validation ?? undefined,
        note:
          kind === "script"
            ? undefined
            : `Find the entity with ha_list_automation_configs (kind='${kind}') — the entity_id is derived from the ${kind === "scene" ? "name" : "alias"}.`,
      });
    },
  );

  defineTool(
    ctx,
    "ha_delete_automation_config",
    {
      title: "Delete an automation, script or scene",
      description: "Delete a UI-managed automation, script or scene by config id and remove its entity. Cannot be undone.",
      inputSchema: { kind: KIND, id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ kind, id }) => {
      await ha.delete(configPath(kind, id), CAP);
      return { deleted: true, kind, id };
    },
  );

  defineTool(
    ctx,
    "ha_get_automation_traces",
    {
      title: "Get automation or script run traces",
      description:
        "Debug automations and scripts with their stored run traces. Without run_id: list recent runs (run_id, start/finish time, state, script_execution result, trigger, error, last_step). " +
        "With run_id: the step-by-step trace (each path with result/error), the trigger, variables and the config that ran. item_id is the automation config id or the script key.",
      inputSchema: {
        domain: z.enum(["automation", "script"]),
        item_id: z.string().optional().describe("Config id; omit to list runs of all items of this domain"),
        run_id: z.string().optional(),
        full: z.boolean().default(false).describe("Return the raw trace instead of the compact form"),
      },
      annotations: READ_ONLY,
    },
    async ({ domain, item_id, run_id, full }) => {
      if (!run_id) {
        const runs = await ws<any[]>(ha, "trace/list", defined({ domain, item_id }));
        return (runs ?? [])
          .map((r) =>
            defined({
              item_id: r.item_id,
              run_id: r.run_id,
              start: r.timestamp?.start,
              finish: r.timestamp?.finish,
              state: r.state,
              script_execution: r.script_execution,
              trigger: r.trigger,
              error: r.error,
              last_step: r.last_step,
            }),
          )
          .sort((a: any, b: any) => String(b.start).localeCompare(String(a.start)));
      }
      const t = await ws<any>(ha, "trace/get", { domain, item_id: need(item_id, "item_id", "get trace"), run_id });
      if (full || !t) return t;
      return defined({
        item_id: t.item_id,
        run_id: t.run_id,
        state: t.state,
        script_execution: t.script_execution,
        error: t.error,
        timestamp: t.timestamp,
        trigger: t.trigger,
        last_step: t.last_step,
        steps: compactTrace(t.trace),
        config: t.config,
        blueprint_inputs: t.blueprint_inputs ?? undefined,
      });
    },
  );

  // ------------------------------------------------------------- blueprints

  defineTool(
    ctx,
    "ha_list_blueprints",
    {
      title: "List blueprints",
      description:
        "List installed automation or script blueprints: path (use in use_blueprint.path), name, description, source_url and inputs (name, description, default, selector).",
      inputSchema: { domain: z.enum(["automation", "script"]).default("automation") },
      annotations: READ_ONLY,
    },
    async ({ domain }) => {
      const res = await ws<Record<string, any>>(ha, "blueprint/list", { domain });
      return Object.entries(res ?? {}).map(([path, bp]) =>
        bp?.error
          ? { path, error: bp.error }
          : defined({
              path,
              name: bp?.metadata?.name,
              description: bp?.metadata?.description,
              source_url: bp?.metadata?.source_url,
              inputs: bp?.metadata?.input,
            }),
      );
    },
  );

  defineTool(
    ctx,
    "ha_manage_blueprint",
    {
      title: "Import or delete a blueprint",
      description:
        "import: download a blueprint from a URL (GitHub, gist or the Home Assistant community forum) and save it. Use overwrite=true to replace an existing file with the same name. " +
        "delete: remove a blueprint file (fails if automations/scripts still use it). " +
        "To create an automation from a blueprint use ha_save_automation_config with use_blueprint.",
      inputSchema: {
        action: z.enum(["import", "delete"]),
        url: z.string().optional().describe("import: blueprint URL"),
        domain: z.enum(["automation", "script"]).optional().describe("delete: blueprint domain"),
        path: z.string().optional().describe("delete: blueprint path as listed by ha_list_blueprints"),
        overwrite: z.boolean().default(false),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, url, domain, path, overwrite }) => {
      if (action === "delete") {
        await ws(ha, "blueprint/delete", { domain: need(domain, "domain", action), path: need(path, "path", action) });
        return { deleted: true, domain, path };
      }
      const imported = await ws<any>(ha, "blueprint/import", { url: need(url, "url", action) });
      const bpDomain = imported?.blueprint?.metadata?.domain;
      if (!bpDomain || !imported?.raw_data) throw new HAError("Home Assistant returned no blueprint for this URL");
      if (imported.validation_errors?.length) {
        return { saved: false, validation_errors: imported.validation_errors };
      }
      if (imported.exists && !overwrite) {
        return {
          saved: false,
          exists: true,
          path: `${imported.suggested_filename}.yaml`,
          note: "A blueprint with this name already exists. Call again with overwrite=true to replace it.",
        };
      }
      const res = await ws<any>(ha, "blueprint/save", {
        domain: bpDomain,
        path: imported.suggested_filename,
        yaml: imported.raw_data,
        source_url: url,
        ...(overwrite ? { allow_override: true } : {}),
      });
      return {
        saved: true,
        domain: bpDomain,
        path: `${imported.suggested_filename}.yaml`,
        name: imported.blueprint.metadata.name,
        inputs: imported.blueprint.metadata.input,
        overrides_existing: res?.overrides_existing ?? false,
      };
    },
  );
}
