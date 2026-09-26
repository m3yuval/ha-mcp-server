import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HAClient, HAError } from "./ha-client.js";

/** Max characters returned by a single tool call, to keep responses usable. */
const MAX_OUTPUT_CHARS = 60_000;

interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function ok(data: unknown) {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + `\n\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars — narrow the query]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  const msg = err instanceof HAError || err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/** Wrap a handler so thrown errors become MCP tool errors instead of protocol errors. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

function compactState(s: HAState) {
  const a = s.attributes ?? {};
  const out: Record<string, unknown> = { entity_id: s.entity_id, state: s.state };
  if (a.friendly_name) out.name = a.friendly_name;
  if (a.unit_of_measurement) out.unit = a.unit_of_measurement;
  if (a.device_class) out.device_class = a.device_class;
  out.last_changed = s.last_changed;
  return out;
}

function isoHoursAgo(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

async function renderJson<T>(ha: HAClient, template: string): Promise<T> {
  const raw = await ha.renderTemplate(template);
  try {
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as T;
  } catch {
    throw new HAError(`Unexpected template output: ${String(raw).slice(0, 200)}`);
  }
}

/** Escape a value for safe use inside a single-quoted Jinja string literal. */
function jinjaStr(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function registerTools(server: McpServer, ha: HAClient, opts: { enableTemplateTool: boolean }) {
  server.registerTool(
    "ha_get_config",
    {
      title: "Get Home Assistant config",
      description:
        "Get basic info about the Home Assistant instance: version, location name, time zone, unit system, and whether it is running. Good first call to check connectivity.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const c = await ha.get<Record<string, any>>("/api/config");
      return {
        version: c.version,
        location_name: c.location_name,
        time_zone: c.time_zone,
        country: c.country,
        language: c.language,
        currency: c.currency,
        unit_system: c.unit_system,
        state: c.state,
        safe_mode: c.safe_mode,
        component_count: Array.isArray(c.components) ? c.components.length : undefined,
      };
    }),
  );

  server.registerTool(
    "ha_list_domains",
    {
      title: "List entity domains",
      description:
        "List entity domains (light, sensor, switch, climate, automation, ...) with how many entities each has. Use this to get an overview before listing entities.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const states = await ha.get<HAState[]>("/api/states");
      const counts: Record<string, number> = {};
      for (const s of states) {
        const d = s.entity_id.split(".")[0];
        counts[d] = (counts[d] ?? 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
    }),
  );

  server.registerTool(
    "ha_list_entities",
    {
      title: "List entities",
      description:
        "List entities with their current state, in a compact form. Filter by domain (e.g. 'light'), by area (name or id), and/or by a search string matched against entity_id and friendly name. Use ha_get_state for full attributes.",
      inputSchema: {
        domain: z.string().optional().describe("Entity domain, e.g. 'light', 'sensor', 'climate'"),
        area: z.string().optional().describe("Area name or area id, e.g. 'Living Room'"),
        search: z.string().optional().describe("Case-insensitive text to match in entity_id or friendly name"),
        state: z.string().optional().describe("Only entities with this exact state, e.g. 'on', 'unavailable'"),
        limit: z.number().int().min(1).max(1000).default(200).describe("Max entities to return"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ domain, area, search, state, limit }) => {
      let states = await ha.get<HAState[]>("/api/states");
      if (domain) states = states.filter((s) => s.entity_id.startsWith(domain + "."));
      if (state) states = states.filter((s) => s.state === state);
      if (search) {
        const q = search.toLowerCase();
        states = states.filter(
          (s) =>
            s.entity_id.toLowerCase().includes(q) ||
            String(s.attributes?.friendly_name ?? "").toLowerCase().includes(q),
        );
      }
      if (area) {
        const a = jinjaStr(area);
        const found = await renderJson<{ id: string | null; entities: string[] }>(
          ha,
          `{% set a = '${a}' if area_name('${a}') else area_id('${a}') %}{{ {'id': a or none, 'entities': area_entities(a) if a else []} | tojson }}`,
        );
        if (!found.id) {
          throw new HAError(`Area '${area}' not found. Use ha_list_areas to see area names and ids.`);
        }
        const set = new Set(found.entities);
        states = states.filter((s) => set.has(s.entity_id));
      }
      const total = states.length;
      states.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
      return { total, returned: Math.min(total, limit), entities: states.slice(0, limit).map(compactState) };
    }),
  );

  server.registerTool(
    "ha_get_state",
    {
      title: "Get entity state",
      description:
        "Get the full current state and all attributes of one or more entities, e.g. ['climate.living_room', 'sensor.outdoor_temperature'].",
      inputSchema: {
        entity_ids: z.array(z.string()).min(1).max(50).describe("Entity ids to fetch"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ entity_ids }) => {
      const results = await Promise.all(
        entity_ids.map(async (id) => {
          try {
            return await ha.get<HAState>(`/api/states/${encodeURIComponent(id)}`);
          } catch (err) {
            return { entity_id: id, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return results.length === 1 ? results[0] : results;
    }),
  );

  server.registerTool(
    "ha_list_areas",
    {
      title: "List areas",
      description: "List all areas (rooms) with their id, name, and the entities assigned to each.",
      inputSchema: {
        include_entities: z.boolean().default(true).describe("Include the entity ids in each area"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ include_entities }) => {
      const tpl = include_entities
        ? "{% set ns = namespace(o=[]) %}{% for a in areas() %}{% set ns.o = ns.o + [{'id': a, 'name': area_name(a), 'entities': area_entities(a)}] %}{% endfor %}{{ ns.o | tojson }}"
        : "{% set ns = namespace(o=[]) %}{% for a in areas() %}{% set ns.o = ns.o + [{'id': a, 'name': area_name(a), 'entity_count': area_entities(a) | count}] %}{% endfor %}{{ ns.o | tojson }}";
      return renderJson(ha, tpl);
    }),
  );

  server.registerTool(
    "ha_list_services",
    {
      title: "List available actions (services)",
      description:
        "List the actions (services) Home Assistant offers. Without a domain, returns every domain with its action names. With a domain, returns each action's description and fields. This is for discovery only — this server cannot run actions.",
      inputSchema: {
        domain: z.string().optional().describe("Only this domain, e.g. 'light' or 'climate'"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ domain }) => {
      const all = await ha.get<{ domain: string; services: Record<string, any> }[]>("/api/services");
      if (!domain) {
        return Object.fromEntries(all.map((d) => [d.domain, Object.keys(d.services)]));
      }
      const d = all.find((x) => x.domain === domain);
      if (!d) throw new HAError(`Unknown domain '${domain}'`);
      return Object.fromEntries(
        Object.entries(d.services).map(([name, s]) => [
          name,
          {
            name: s.name,
            description: s.description,
            fields: Object.fromEntries(
              Object.entries(s.fields ?? {}).map(([f, v]: [string, any]) => [
                f,
                { description: v?.description, required: v?.required ?? false, example: v?.example },
              ]),
            ),
          },
        ]),
      );
    }),
  );

  server.registerTool(
    "ha_get_history",
    {
      title: "Get entity history",
      description:
        "Get state history for one or more entities over a time range. Defaults to the last 24 hours. Returns a compact list of {state, time} changes per entity, keeping the most recent max_points.",
      inputSchema: {
        entity_ids: z.array(z.string()).min(1).max(20).describe("Entity ids"),
        start_time: z.string().optional().describe("ISO 8601 start time. Default: 24 hours ago"),
        end_time: z.string().optional().describe("ISO 8601 end time. Default: now"),
        hours: z.number().min(0.1).max(24 * 30).optional().describe("Alternative to start_time: look back this many hours"),
        max_points: z.number().int().min(1).max(2000).default(200).describe("Max changes returned per entity"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ entity_ids, start_time, end_time, hours, max_points }) => {
      const start = start_time ?? isoHoursAgo(hours ?? 24);
      const data = await ha.get<HAState[][]>(`/api/history/period/${encodeURIComponent(start)}`, {
        filter_entity_id: entity_ids.join(","),
        end_time,
        minimal_response: "",
        no_attributes: "",
      });
      const out: Record<string, unknown> = {};
      for (const series of data) {
        if (!series.length) continue;
        const id = series[0].entity_id;
        const points = series.map((p) => ({ s: p.state, t: p.last_changed }));
        out[id] = {
          changes: points.length,
          truncated: points.length > max_points,
          points: points.slice(-max_points),
        };
      }
      return { start, end: end_time ?? "now", entities: out };
    }),
  );

  server.registerTool(
    "ha_get_logbook",
    {
      title: "Get logbook",
      description:
        "Get logbook entries (what happened and why: automations triggered, lights turned on, doors opened). Optionally for a single entity. Defaults to the last 24 hours.",
      inputSchema: {
        entity_id: z.string().optional().describe("Only entries for this entity"),
        start_time: z.string().optional().describe("ISO 8601 start time. Default: 24 hours ago"),
        end_time: z.string().optional().describe("ISO 8601 end time. Default: now"),
        hours: z.number().min(0.1).max(24 * 30).optional().describe("Alternative to start_time: look back this many hours"),
        limit: z.number().int().min(1).max(2000).default(200).describe("Max entries (most recent kept)"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ entity_id, start_time, end_time, hours, limit }) => {
      const start = start_time ?? isoHoursAgo(hours ?? 24);
      const entries = await ha.get<any[]>(`/api/logbook/${encodeURIComponent(start)}`, {
        entity: entity_id,
        end_time,
      });
      return { total: entries.length, entries: entries.slice(-limit) };
    }),
  );

  server.registerTool(
    "ha_list_calendars",
    {
      title: "List calendars",
      description: "List calendar entities in Home Assistant.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      try {
        return await ha.get("/api/calendars");
      } catch (err) {
        // HA only registers /api/calendars when the calendar integration is loaded.
        if (err instanceof HAError && err.status === 404) {
          return { calendars: [], note: "No calendar integration is set up in this Home Assistant." };
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "ha_get_calendar_events",
    {
      title: "Get calendar events",
      description: "Get events from a calendar entity between two times. Defaults to the next 7 days.",
      inputSchema: {
        entity_id: z.string().describe("Calendar entity id, e.g. 'calendar.family'"),
        start: z.string().optional().describe("ISO 8601 start. Default: now"),
        end: z.string().optional().describe("ISO 8601 end. Default: start + 7 days"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ entity_id, start, end }) => {
      const s = start ?? new Date().toISOString();
      const e = end ?? new Date(new Date(s).getTime() + 7 * 86400_000).toISOString();
      try {
        return await ha.get(`/api/calendars/${encodeURIComponent(entity_id)}`, { start: s, end: e });
      } catch (err) {
        if (err instanceof HAError && err.status === 404) {
          throw new HAError(`Calendar '${entity_id}' not found. Use ha_list_calendars to see calendars.`);
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    "ha_get_error_log",
    {
      title: "Get error log",
      description:
        "Get recent errors and warnings logged by Home Assistant (the same list as Settings → System → Logs), newest first. Useful for debugging integrations.",
      inputSchema: {
        level: z
          .enum(["ERROR", "WARNING", "CRITICAL", "INFO", "DEBUG"])
          .optional()
          .describe("Only entries of this level. Default: all levels"),
        search: z.string().optional().describe("Case-insensitive text to match in the logger name, source or message"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max entries to return"),
        include_exceptions: z.boolean().default(false).describe("Include stack traces (can be long)"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ level, search, limit, include_exceptions }) => {
      let entries = await ha.wsCommand<any[]>("system_log/list");
      if (level) entries = entries.filter((e) => e.level === level);
      if (search) {
        const q = search.toLowerCase();
        entries = entries.filter((e) =>
          [e.name, ...(e.source ?? []), ...(e.message ?? [])].some((v) => String(v).toLowerCase().includes(q)),
        );
      }
      entries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      const total = entries.length;
      return {
        total,
        returned: Math.min(total, limit),
        entries: entries.slice(0, limit).map((e) => ({
          level: e.level,
          logger: e.name,
          message: Array.isArray(e.message) ? e.message.join("\n") : e.message,
          source: Array.isArray(e.source) ? e.source.join(":") : e.source,
          count: e.count,
          first_occurred: e.first_occurred ? new Date(e.first_occurred * 1000).toISOString() : undefined,
          last_occurred: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined,
          exception: include_exceptions && e.exception ? String(e.exception).slice(0, 4000) : undefined,
        })),
      };
    }),
  );

  if (opts.enableTemplateTool) {
    server.registerTool(
      "ha_render_template",
      {
        title: "Render a template",
        description:
          "Render a Home Assistant Jinja template and return the result. Templates can read states, areas, devices and do math, but cannot change anything. Example: \"{{ states.light | selectattr('state','eq','on') | map(attribute='entity_id') | list }}\"",
        inputSchema: {
          template: z.string().min(1).max(10_000).describe("Jinja template text"),
        },
        annotations: READ_ONLY,
      },
      safe(async ({ template }) => ha.renderTemplate(template)),
    );
  }
}
