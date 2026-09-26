import { z } from "zod";
import { HAError } from "../../ha-client.js";
import { DESTRUCTIVE, READ_ONLY, defineTool, type ToolContext } from "../common.js";
import { defined, matches, need, ws } from "./util.js";

const nullableStr = z.string().nullable().optional();

function requireChanges(changes: Record<string, unknown>) {
  if (!Object.keys(changes).length) throw new HAError("Nothing to update: pass at least one field to change");
  return changes;
}

export function registerRegistryTools(ctx: ToolContext) {
  const { ha } = ctx;

  defineTool(
    ctx,
    "ha_list_registry",
    {
      title: "List areas, floors, labels or categories",
      description:
        "List registry items with their ids and settings: 'area' (with floor_id, aliases, icon, labels), 'floor' (level), 'label' (color, icon, description) or 'category' (needs scope: 'automation', 'script', 'scene' or 'helpers'). " +
        "Use the ids with ha_manage_area/floor/label/category, ha_manage_device and ha_manage_entity.",
      inputSchema: {
        registry: z.enum(["area", "floor", "label", "category"]),
        scope: z.string().optional().describe("category only: automation | script | scene | helpers"),
      },
      annotations: READ_ONLY,
    },
    async ({ registry, scope }) => {
      if (registry === "category") {
        return ha.wsRead("config/category_registry/list", { scope: need(scope, "scope", "category list") });
      }
      return ha.wsRead(`config/${registry}_registry/list`);
    },
  );

  defineTool(
    ctx,
    "ha_manage_area",
    {
      title: "Create, update or delete an area",
      description:
        "Create, update or delete an area (room). For update/delete pass area_id (see ha_list_areas or ha_list_registry). " +
        "Deleting an area unassigns its devices and entities; it does not delete them.",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]),
        area_id: z.string().optional(),
        name: z.string().optional().describe("create: required"),
        floor_id: nullableStr.describe("Floor this area is on (null to clear)"),
        icon: nullableStr.describe("e.g. 'mdi:sofa'"),
        aliases: z.array(z.string()).optional().describe("Alternative names for voice assistants"),
        labels: z.array(z.string()).optional().describe("Label ids (replaces the current list)"),
        picture: nullableStr,
        temperature_entity_id: nullableStr,
        humidity_entity_id: nullableStr,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, area_id, ...fields }) => {
      const data = defined(fields);
      if (action === "create") return ws(ha, "config/area_registry/create", { ...data, name: need(fields.name, "name", action) });
      need(area_id, "area_id", action);
      if (action === "delete") return ws(ha, "config/area_registry/delete", { area_id });
      return ws(ha, "config/area_registry/update", { area_id, ...requireChanges(data) });
    },
  );

  defineTool(
    ctx,
    "ha_manage_floor",
    {
      title: "Create, update or delete a floor",
      description: "Create, update or delete a floor. Assign areas to floors with ha_manage_area (floor_id). Deleting a floor unassigns its areas.",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]),
        floor_id: z.string().optional(),
        name: z.string().optional().describe("create: required"),
        level: z.number().int().nullable().optional().describe("0 = ground floor, negative = basement"),
        icon: nullableStr,
        aliases: z.array(z.string()).optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, floor_id, ...fields }) => {
      const data = defined(fields);
      if (action === "create") return ws(ha, "config/floor_registry/create", { ...data, name: need(fields.name, "name", action) });
      need(floor_id, "floor_id", action);
      if (action === "delete") return ws(ha, "config/floor_registry/delete", { floor_id });
      return ws(ha, "config/floor_registry/update", { floor_id, ...requireChanges(data) });
    },
  );

  defineTool(
    ctx,
    "ha_manage_label",
    {
      title: "Create, update or delete a label",
      description:
        "Create, update or delete a label. Apply labels with ha_manage_area / ha_manage_device / ha_manage_entity (labels field). Deleting a label removes it everywhere.",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]),
        label_id: z.string().optional(),
        name: z.string().optional().describe("create: required"),
        icon: nullableStr,
        color: nullableStr.describe("e.g. 'red', 'indigo' or a hex color"),
        description: nullableStr,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, label_id, ...fields }) => {
      const data = defined(fields);
      if (action === "create") return ws(ha, "config/label_registry/create", { ...data, name: need(fields.name, "name", action) });
      need(label_id, "label_id", action);
      if (action === "delete") return ws(ha, "config/label_registry/delete", { label_id });
      return ws(ha, "config/label_registry/update", { label_id, ...requireChanges(data) });
    },
  );

  defineTool(
    ctx,
    "ha_manage_category",
    {
      title: "Create, update or delete a category",
      description:
        "Create, update or delete a category used to group automations, scripts, scenes or helpers in the UI. scope is 'automation', 'script', 'scene' or 'helpers'. " +
        "Put an entity in a category with ha_manage_entity (categories: {scope: category_id}).",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]),
        scope: z.string().describe("automation | script | scene | helpers"),
        category_id: z.string().optional(),
        name: z.string().optional().describe("create: required"),
        icon: nullableStr,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, scope, category_id, name, icon }) => {
      const data = defined({ name, icon });
      if (action === "create") return ws(ha, "config/category_registry/create", { scope, ...data, name: need(name, "name", action) });
      need(category_id, "category_id", action);
      if (action === "delete") return ws(ha, "config/category_registry/delete", { scope, category_id });
      return ws(ha, "config/category_registry/update", { scope, category_id, ...requireChanges(data) });
    },
  );

  // ---------------------------------------------------------------- devices

  defineTool(
    ctx,
    "ha_list_devices",
    {
      title: "List devices",
      description:
        "List devices from the device registry: id, name (and name_by_user), manufacturer, model, area_id, labels, disabled_by and the integration(s) they belong to. " +
        "Filter by area, integration domain, config entry, or a search string.",
      inputSchema: {
        area_id: z.string().optional(),
        domain: z.string().optional().describe("Integration domain, e.g. 'zha'"),
        entry_id: z.string().optional().describe("Config entry id"),
        search: z.string().optional().describe("Substring matched against names, manufacturer and model"),
        include_disabled: z.boolean().default(true),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: READ_ONLY,
    },
    async ({ area_id, domain, entry_id, search, include_disabled, limit }) => {
      const [devices, entries] = await Promise.all([
        ha.wsRead<any[]>("config/device_registry/list"),
        ha.wsRead<any[]>("config_entries/get").catch(() => [] as any[]),
      ]);
      const domainOf = new Map(entries.map((e) => [e.entry_id, e.domain]));
      const entryIds = (d: any): string[] =>
        Array.isArray(d.config_entries) ? d.config_entries : d.config_entry_id ? [d.config_entry_id] : [];
      const out = devices
        .filter((d) => {
          const ids = entryIds(d);
          if (area_id && d.area_id !== area_id) return false;
          if (entry_id && !ids.includes(entry_id)) return false;
          if (domain && !ids.some((i) => domainOf.get(i) === domain)) return false;
          if (!include_disabled && d.disabled_by) return false;
          return matches(search, d.name, d.name_by_user, d.manufacturer, d.model, d.id);
        })
        .map((d) =>
          defined({
            id: d.id,
            name: d.name_by_user ?? d.name,
            original_name: d.name_by_user ? d.name : undefined,
            manufacturer: d.manufacturer ?? undefined,
            model: d.model ?? undefined,
            area_id: d.area_id ?? undefined,
            labels: d.labels?.length ? d.labels : undefined,
            disabled_by: d.disabled_by ?? undefined,
            entry_type: d.entry_type ?? undefined,
            via_device_id: d.via_device_id ?? undefined,
            config_entries: entryIds(d),
            integrations: [...new Set(entryIds(d).map((i) => domainOf.get(i)).filter(Boolean))],
          }),
        );
      return { total: out.length, devices: out.slice(0, limit) };
    },
  );

  defineTool(
    ctx,
    "ha_manage_device",
    {
      title: "Update or remove a device",
      description:
        "update: rename (name_by_user, null restores the default name), move to an area (area_id), set labels (replaces the list), or disable/enable (disabled_by 'user' or null). " +
        "remove: remove the device from Home Assistant. Only works if its integration supports removing devices (supports_remove_device in ha_list_integrations); typically used for devices that are gone.",
      inputSchema: {
        action: z.enum(["update", "remove"]),
        device_id: z.string(),
        name_by_user: nullableStr,
        area_id: nullableStr,
        labels: z.array(z.string()).optional(),
        disabled_by: z.enum(["user"]).nullable().optional().describe("'user' to disable, null to enable"),
        config_entry_id: z
          .string()
          .optional()
          .describe("remove: the config entry to remove the device from (only needed on older Home Assistant versions when the device belongs to several)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, device_id, config_entry_id, ...fields }) => {
      if (action === "update") {
        return ws(ha, "config/device_registry/update", { device_id, ...requireChanges(defined(fields)) });
      }
      try {
        return (await ws(ha, "config/device_registry/remove", { device_id })) ?? { removed: device_id };
      } catch (err) {
        // Older Home Assistant versions only have remove_config_entry.
        if (!/unknown.?command|unknown_command/i.test(String((err as Error).message))) throw err;
      }
      let entry = config_entry_id;
      if (!entry) {
        const devices = await ha.wsRead<any[]>("config/device_registry/list");
        const d = devices.find((x) => x.id === device_id);
        if (!d) throw new HAError(`Device not found: ${device_id}`);
        const ids: string[] = Array.isArray(d.config_entries) ? d.config_entries : d.config_entry_id ? [d.config_entry_id] : [];
        if (ids.length !== 1) {
          throw new HAError(`Device belongs to ${ids.length} config entries (${ids.join(", ")}); pass config_entry_id`);
        }
        entry = ids[0];
      }
      await ws(ha, "config/device_registry/remove_config_entry", { device_id, config_entry_id: entry });
      return { removed: device_id, config_entry_id: entry };
    },
  );

  // --------------------------------------------------------------- entities

  defineTool(
    ctx,
    "ha_list_entity_registry",
    {
      title: "List or inspect entity registry entries",
      description:
        "Entity registry view, including disabled and hidden entities that don't appear in states. " +
        "With entity_id: full registry entry (name, original_name, icon, area_id, device_id, labels, categories, disabled_by, hidden_by, aliases, options, unique_id, platform). " +
        "Without: a filtered compact list. Use ha_manage_entity to change entries.",
      inputSchema: {
        entity_id: z.string().optional(),
        domain: z.string().optional().describe("Entity domain, e.g. 'sensor'"),
        platform: z.string().optional().describe("Integration that provides the entity, e.g. 'mqtt'"),
        device_id: z.string().optional(),
        area_id: z.string().optional().describe("Entities assigned directly to this area"),
        status: z.enum(["all", "enabled", "disabled", "hidden"]).default("all"),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(300),
      },
      annotations: READ_ONLY,
    },
    async ({ entity_id, domain, platform, device_id, area_id, status, search, limit }) => {
      if (entity_id) return ha.wsRead("config/entity_registry/get", { entity_id });
      const all = await ha.wsRead<any[]>("config/entity_registry/list");
      const out = all
        .filter((e) => {
          if (domain && !String(e.entity_id).startsWith(`${domain}.`)) return false;
          if (platform && e.platform !== platform) return false;
          if (device_id && e.device_id !== device_id) return false;
          if (area_id && e.area_id !== area_id) return false;
          if (status === "enabled" && e.disabled_by) return false;
          if (status === "disabled" && !e.disabled_by) return false;
          if (status === "hidden" && !e.hidden_by) return false;
          return matches(search, e.entity_id, e.name, e.original_name);
        })
        .map((e) =>
          defined({
            entity_id: e.entity_id,
            name: e.name ?? e.original_name ?? undefined,
            platform: e.platform,
            device_id: e.device_id ?? undefined,
            area_id: e.area_id ?? undefined,
            labels: e.labels?.length ? e.labels : undefined,
            disabled_by: e.disabled_by ?? undefined,
            hidden_by: e.hidden_by ?? undefined,
          }),
        );
      return { total: out.length, entities: out.slice(0, limit) };
    },
  );

  defineTool(
    ctx,
    "ha_manage_entity",
    {
      title: "Update or remove an entity registry entry",
      description:
        "update: change an entity's name (null = use the default), icon, area_id (null = follow the device), labels (replaces the list), categories ({scope: category_id or null}), aliases, device_class, " +
        "disabled_by ('user' or null), hidden_by ('user' or null), or rename it with new_entity_id (automations referring to the old id are NOT updated). " +
        "remove: delete the registry entry. Only for orphaned entities whose integration no longer provides them; active entities come back on the next restart.",
      inputSchema: {
        action: z.enum(["update", "remove"]),
        entity_id: z.string(),
        name: nullableStr,
        icon: nullableStr,
        area_id: nullableStr,
        labels: z.array(z.string()).optional(),
        categories: z.record(z.string().nullable()).optional(),
        aliases: z.array(z.string()).optional(),
        device_class: nullableStr,
        disabled_by: z.enum(["user"]).nullable().optional(),
        hidden_by: z.enum(["user"]).nullable().optional(),
        new_entity_id: z.string().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, entity_id, ...fields }) => {
      if (action === "remove") {
        await ws(ha, "config/entity_registry/remove", { entity_id });
        return { removed: entity_id };
      }
      return ws(ha, "config/entity_registry/update", { entity_id, ...requireChanges(defined(fields)) });
    },
  );
}
