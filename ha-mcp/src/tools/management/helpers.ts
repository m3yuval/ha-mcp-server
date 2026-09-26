import { z } from "zod";
import { HAError } from "../../ha-client.js";
import { DESTRUCTIVE, READ_ONLY, defineTool, type ToolContext } from "../common.js";
import { defined, need, ws } from "./util.js";

/** Storage collections managed with <domain>/list|create|update|delete and <domain>_id. */
export const COLLECTION_DOMAINS = [
  "input_boolean",
  "input_number",
  "input_text",
  "input_select",
  "input_datetime",
  "input_button",
  "counter",
  "timer",
  "schedule",
  "person",
  "zone",
  "tag",
] as const;

const FIELDS_HELP =
  "Fields per domain (name is required on create; icon like 'mdi:flag' everywhere):\n" +
  "- input_boolean: name, icon, initial (bool)\n" +
  "- input_number: name, min, max, step, mode ('slider'|'box'), unit_of_measurement, initial, icon\n" +
  "- input_text: name, min, max (length), pattern (regex), mode ('text'|'password'), initial, icon\n" +
  "- input_select: name, options (list of strings), initial, icon\n" +
  "- input_datetime: name, has_date (bool), has_time (bool), initial, icon\n" +
  "- input_button: name, icon\n" +
  "- counter: name, initial, step, minimum, maximum, restore (bool), icon\n" +
  "- timer: name, duration ('HH:MM:SS'), restore (bool), icon\n" +
  "- schedule: name, icon, monday..sunday: [{from: 'HH:MM:SS', to: 'HH:MM:SS'}]\n" +
  "- person: name, user_id (or null), device_trackers (list of entity ids), picture\n" +
  "- zone: name, latitude, longitude, radius (m), passive (bool), icon\n" +
  "- tag: name, description; on create optionally tag_id (the tag's own id; generated if omitted)\n" +
  "Template, group, utility_meter and other config-entry based helpers are added with ha_integration_flow (handler e.g. 'template', 'group').";

export function registerHelperTools(ctx: ToolContext) {
  const { ha } = ctx;

  defineTool(
    ctx,
    "ha_list_helpers",
    {
      title: "List helpers, people, zones and tags",
      description:
        "List UI-managed helpers (input_boolean, input_number, input_text, input_select, input_datetime, input_button, counter, timer, schedule) and people, zones and tags, with their id and settings. " +
        "The id is what ha_manage_helper needs. Without domain, lists all of them.",
      inputSchema: {
        domain: z.enum(COLLECTION_DOMAINS).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ domain }) => {
      const domains = domain ? [domain] : [...COLLECTION_DOMAINS];
      const out: Record<string, unknown> = {};
      await Promise.all(
        domains.map(async (d) => {
          try {
            const res = await ws<any>(ha, `${d}/list`);
            // person/list returns {storage: [...], config: [...]} (config = YAML, read-only)
            out[d] = d === "person" && res && !Array.isArray(res) ? { ...res } : res;
          } catch (err) {
            out[d] = { error: (err as Error).message };
          }
        }),
      );
      return domain ? out[domain] : out;
    },
  );

  defineTool(
    ctx,
    "ha_manage_helper",
    {
      title: "Create, update or delete a helper, person, zone or tag",
      description:
        "Create, update or delete a UI-managed helper, person, zone or tag. update/delete need the item id from ha_list_helpers (not the entity_id). " +
        "update only changes the fields you pass.\n" +
        FIELDS_HELP,
      inputSchema: {
        domain: z.enum(COLLECTION_DOMAINS),
        action: z.enum(["create", "update", "delete"]),
        id: z.string().optional().describe("update/delete: the item id"),
        config: z.record(z.any()).optional().describe("create/update: the fields, e.g. {\"name\": \"Guest mode\", \"icon\": \"mdi:account\"}"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ domain, action, id, config }) => {
      const fields = { ...(config ?? {}) };
      const idKey = `${domain}_id`;
      if (action === "create") {
        if (domain !== "tag") need(fields.name, "config.name", action);
        return ws(ha, `${domain}/create`, fields);
      }
      need(id, "id", action);
      if (action === "delete") {
        await ws(ha, `${domain}/delete`, { [idKey]: id });
        return { deleted: true, domain, id };
      }
      delete fields[idKey];
      if (!Object.keys(fields).length) throw new HAError("Nothing to update: pass the fields to change in config");
      return ws(ha, `${domain}/update`, { [idKey]: id, ...fields });
    },
  );

  // ------------------------------------------------------------------ users

  defineTool(
    ctx,
    "ha_list_users",
    {
      title: "List users",
      description:
        "List Home Assistant users: id, name, username, whether they are owner/admin/active, local_only, group_ids and whether they are system-generated (internal users such as add-ons).",
      inputSchema: {
        include_system: z.boolean().default(false).describe("Include system-generated users"),
      },
      annotations: READ_ONLY,
    },
    async ({ include_system }) => {
      const users = await ws<any[]>(ha, "config/auth/list");
      return users
        .filter((u) => include_system || !u.system_generated)
        .map((u) =>
          defined({
            id: u.id,
            name: u.name,
            username: u.username ?? undefined,
            is_owner: u.is_owner,
            is_admin: u.is_admin ?? (u.group_ids ?? []).includes("system-admin"),
            is_active: u.is_active,
            local_only: u.local_only,
            system_generated: u.system_generated,
            group_ids: u.group_ids,
          }),
        );
    },
  );

  defineTool(
    ctx,
    "ha_manage_user",
    {
      title: "Create, update or delete a user",
      description:
        "Manage Home Assistant user accounts.\n" +
        "- create: name (required), group_ids (['system-users'] default; 'system-admin' for administrators), local_only; pass username and password to also create a login.\n" +
        "- update: name, is_active, group_ids, local_only.\n" +
        "- set_password: set a new password for a user's login (password).\n" +
        "- delete: permanently delete the user. The owner and system-generated users can't be deleted.\n" +
        "Accounts are the keys to the whole home: an admin (group 'system-admin') has full control of Home Assistant. " +
        "create, set_password, delete, deactivating (is_active=false) and any group_ids change require confirm: true. " +
        "Only do this when the user explicitly asks; confirm the exact details (and whether the account is an admin) with them first. " +
        "Passwords are never returned or logged.",
      inputSchema: {
        action: z.enum(["create", "update", "set_password", "delete"]),
        user_id: z.string().optional().describe("update/set_password/delete"),
        name: z.string().optional(),
        username: z.string().optional().describe("create: login username (lowercase)"),
        password: z.string().optional().describe("create/set_password"),
        group_ids: z.array(z.string()).optional().describe("'system-admin', 'system-users' or 'system-read-only'"),
        is_active: z.boolean().optional(),
        local_only: z.boolean().optional().describe("Can only log in from the local network"),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true for create, set_password, delete, deactivation and group changes. Ask the user first."),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, user_id, name, username, password, group_ids, is_active, local_only, confirm }) => {
      const sensitive =
        action !== "update" || group_ids !== undefined || is_active === false;
      if (sensitive && confirm !== true) {
        const what =
          action === "update"
            ? group_ids !== undefined
              ? `change the groups of user '${user_id ?? "?"}'${group_ids.includes("system-admin") ? " (granting administrator)" : ""}`
              : `deactivate user '${user_id ?? "?"}'`
            : action === "create"
              ? `create ${group_ids?.includes("system-admin") ? "an ADMINISTRATOR account (full control of Home Assistant)" : "a user account"}`
              : action === "set_password"
                ? `set the password of user '${user_id ?? "?"}'`
                : `delete user '${user_id ?? "?"}'`;
        throw new HAError(
          `Refusing to ${what} without confirm: true. Explain exactly what will change to the user, get their explicit approval, then call again with confirm: true.`,
        );
      }
      if (action === "create") {
        if ((username === undefined) !== (password === undefined)) {
          throw new HAError("Pass both username and password to create a login, or neither");
        }
        const res = await ws<{ user: any }>(ha, "config/auth/create", {
          name: need(name, "name", action),
          ...defined({ group_ids: group_ids ?? ["system-users"], local_only }),
        });
        const user = res?.user;
        if (username && user?.id) {
          await ws(ha, "config/auth_provider/homeassistant/create", { user_id: user.id, username, password });
        }
        return { created: true, user, login: username ? { username } : undefined };
      }
      need(user_id, "user_id", action);
      if (action === "delete") {
        await ws(ha, "config/auth/delete", { user_id });
        return { deleted: true, user_id };
      }
      if (action === "set_password") {
        await ws(ha, "config/auth_provider/homeassistant/admin_change_password", {
          user_id,
          password: need(password, "password", action),
        });
        return { password_changed: true, user_id };
      }
      const changes = defined({ name, is_active, group_ids, local_only });
      if (!Object.keys(changes).length) throw new HAError("Nothing to update");
      return ws(ha, "config/auth/update", { user_id, ...changes });
    },
  );
}
