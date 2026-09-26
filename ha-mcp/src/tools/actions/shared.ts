/**
 * Shared helpers for the action tools: input schemas, service discovery
 * (cached), entity pre-checks, running a service call and reporting the
 * resulting states compactly.
 */
import { z } from "zod";
import { HAClient, HAError, type ServiceCallOptions } from "../../ha-client.js";
import type { HAState } from "../common.js";

// ------------------------------------------------------------------ schemas

export const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** Zod schema for one entity id, optionally restricted to some domains. */
export function entityId(domains?: readonly string[]) {
  const base = z
    .string()
    .regex(ENTITY_RE, "must be an entity id like 'light.kitchen' (domain.object_id, lowercase)");
  if (!domains) return base;
  const list = domains.map((d) => `${d}.*`).join(", ");
  return base.refine((v) => domains.includes(v.split(".")[0]), {
    message: `this tool only accepts ${list} entities`,
  });
}

/** One or more entity ids (a single string is accepted too). */
export function entityIds(domains?: readonly string[], max = 50) {
  return z
    .union([entityId(domains), z.array(entityId(domains)).min(1).max(max)])
    .transform((v) => (Array.isArray(v) ? v : [v]));
}

const idOrIds = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** Target selector used by the generic tools. */
export const targetSchema = z
  .object({
    entity_id: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe("Entity id(s), e.g. 'light.kitchen' or ['light.a','light.b']"),
    device_id: idOrIds.optional().describe("Device id(s) from the device registry"),
    area_id: idOrIds.optional().describe("Area id(s), e.g. 'living_room' (see ha_list_areas)"),
    floor_id: idOrIds.optional().describe("Floor id(s), e.g. 'first_floor'"),
    label_id: idOrIds.optional().describe("Label id(s)"),
  })
  .strict();

export type Target = NonNullable<ServiceCallOptions["target"]>;

/** Area/device/floor/label selectors that convenience tools accept next to entity ids. */
export const indirectTargetShape = {
  area_id: idOrIds.optional().describe("Area id(s) instead of / in addition to entity ids, e.g. 'kitchen'"),
  floor_id: idOrIds.optional().describe("Floor id(s), e.g. 'upstairs'"),
  device_id: idOrIds.optional().describe("Device id(s)"),
  label_id: idOrIds.optional().describe("Label id(s)"),
};

export function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function domainOf(entityId: string) {
  return entityId.split(".")[0];
}

export function groupByDomain(ids: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const id of ids) {
    const d = domainOf(id);
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(id);
  }
  return m;
}

// --------------------------------------------------------- service catalog

export interface ServiceMeta {
  name?: string;
  description?: string;
  fields?: Record<string, unknown>;
  target?: unknown;
  response?: { optional?: boolean };
}

type Catalog = Map<string, Map<string, ServiceMeta>>;

const CATALOG_TTL_MS = 30_000;
const catalogCache = new WeakMap<HAClient, { at: number; catalog: Catalog }>();

/** GET /api/services, cached briefly per client. */
export async function getCatalog(ha: HAClient, fresh = false): Promise<Catalog> {
  const hit = catalogCache.get(ha);
  if (!fresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
  const raw = await ha.get<{ domain: string; services: Record<string, ServiceMeta> | string[] }[]>("/api/services");
  const catalog: Catalog = new Map();
  for (const d of raw ?? []) {
    const services = new Map<string, ServiceMeta>();
    if (Array.isArray(d.services)) for (const s of d.services) services.set(s, {});
    else for (const [s, meta] of Object.entries(d.services ?? {})) services.set(s, meta ?? {});
    catalog.set(d.domain, services);
  }
  catalogCache.set(ha, { at: Date.now(), catalog });
  return catalog;
}

export async function hasService(ha: HAClient, domain: string, service: string) {
  return Boolean((await getCatalog(ha)).get(domain)?.has(service));
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Closest "domain.service" names to a wanted one. */
export function closeMatches(wanted: string, candidates: string[], max = 8) {
  const w = wanted.toLowerCase();
  const [wd, ws] = w.split(".");
  return candidates
    .map((c) => {
      const [cd, cs] = c.split(".");
      let score = levenshtein(w, c);
      if (cd === wd) score -= 3;
      if (ws && (cs.includes(ws) || ws.includes(cs))) score -= 3;
      return { c, score };
    })
    .filter((x) => x.score <= Math.max(4, Math.floor(w.length / 3)))
    .sort((a, b) => a.score - b.score || a.c.localeCompare(b.c))
    .slice(0, max)
    .map((x) => x.c);
}

/** Throw a helpful error (with close matches) if domain.service doesn't exist. */
export async function assertServiceExists(ha: HAClient, domain: string, service: string): Promise<ServiceMeta> {
  let catalog = await getCatalog(ha);
  if (!catalog.get(domain)?.has(service)) catalog = await getCatalog(ha, true); // maybe just loaded
  const meta = catalog.get(domain)?.get(service);
  if (meta) return meta;
  const all = [...catalog].flatMap(([d, s]) => [...s.keys()].map((x) => `${d}.${x}`));
  const wanted = `${domain}.${service}`;
  const matches = closeMatches(wanted, all);
  let msg = `Unknown action '${wanted}'.`;
  if (catalog.has(domain)) {
    msg += ` Domain '${domain}' has: ${[...catalog.get(domain)!.keys()].sort().join(", ")}.`;
  } else {
    msg += ` There is no '${domain}' domain with actions.`;
  }
  if (matches.length) msg += ` Did you mean: ${matches.join(", ")}?`;
  msg += " Use ha_list_services to browse available actions.";
  throw new HAError(msg);
}

// ------------------------------------------------------------ entity states

const KEEP_ATTRS = [
  "brightness",
  "color_mode",
  "color_temp_kelvin",
  "rgb_color",
  "effect",
  "percentage",
  "preset_mode",
  "oscillating",
  "direction",
  "hvac_action",
  "temperature",
  "target_temp_low",
  "target_temp_high",
  "current_temperature",
  "humidity",
  "current_humidity",
  "fan_mode",
  "swing_mode",
  "current_position",
  "current_tilt_position",
  "volume_level",
  "is_volume_muted",
  "media_title",
  "media_artist",
  "source",
  "sound_mode",
  "shuffle",
  "repeat",
  "options",
  "min",
  "max",
  "step",
  "fan_speed",
  "battery_level",
  "last_triggered",
  "current",
] as const;

/** Compact state with the attributes that matter to confirm an action. */
export function actionState(s: HAState) {
  const a = s.attributes ?? {};
  const out: Record<string, unknown> = { entity_id: s.entity_id, state: s.state };
  if (a.friendly_name) out.name = a.friendly_name;
  if (a.unit_of_measurement) out.unit = a.unit_of_measurement;
  for (const k of KEEP_ATTRS) {
    if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
  }
  if (typeof a.brightness === "number") out.brightness_pct = Math.round((a.brightness / 255) * 100);
  out.last_changed = s.last_changed;
  return out;
}

async function fetchState(ha: HAClient, id: string): Promise<HAState | null> {
  try {
    return await ha.get<HAState>(`/api/states/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof HAError && err.status === 404) return null;
    throw err;
  }
}

/** Fetch current states and fail early (nothing sent) if any entity doesn't exist. */
export async function requireEntities(ha: HAClient, ids: string[]): Promise<Map<string, HAState>> {
  const out = new Map<string, HAState>();
  const states = await Promise.all(ids.map((id) => fetchState(ha, id)));
  const missing = ids.filter((_, i) => !states[i]);
  if (missing.length) {
    throw new HAError(
      `Entity not found: ${missing.join(", ")}. Nothing was changed. Use ha_list_entities to find the right entity id.`,
    );
  }
  ids.forEach((id, i) => out.set(id, states[i]!));
  return out;
}

/** States after a call, compacted. Missing entities are reported, not thrown. */
export async function statesAfter(ha: HAClient, ids: string[]) {
  const uniq = [...new Set(ids)].slice(0, 50);
  return Promise.all(
    uniq.map(async (id) => {
      try {
        const s = await fetchState(ha, id);
        return s ? actionState(s) : { entity_id: id, error: "not found" };
      } catch (err) {
        return { entity_id: id, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

// ------------------------------------------------------------ running calls

export interface CallResult {
  action: string;
  changed_states: HAState[];
  service_response?: unknown;
}

/**
 * Run a service through the client (which enforces capabilities and blocked
 * domains) and normalize the two REST response shapes.
 */
export async function runService(
  ha: HAClient,
  domain: string,
  service: string,
  opts: ServiceCallOptions,
): Promise<CallResult> {
  const clean: ServiceCallOptions = { ...opts };
  if (clean.target) {
    clean.target = Object.fromEntries(Object.entries(clean.target).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
    if (!Object.keys(clean.target).length) delete clean.target;
  }
  if (clean.data) {
    clean.data = Object.fromEntries(Object.entries(clean.data).filter(([, v]) => v !== undefined));
  }
  const res = await ha.callService<unknown>(domain, service, clean, "actions");
  if (Array.isArray(res)) return { action: `${domain}.${service}`, changed_states: res as HAState[] };
  if (res && typeof res === "object") {
    const r = res as { changed_states?: HAState[]; service_response?: unknown };
    return { action: `${domain}.${service}`, changed_states: r.changed_states ?? [], service_response: r.service_response };
  }
  return { action: `${domain}.${service}`, changed_states: [] };
}

/** Standard result: what was called and the new state of the targeted entities. */
export async function report(ha: HAClient, calls: CallResult[], entityIdsToShow: string[], extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { ok: true, actions: calls.map((c) => c.action) };
  if (entityIdsToShow.length) {
    out.states = await statesAfter(ha, entityIdsToShow);
  } else {
    const changed = calls.flatMap((c) => c.changed_states);
    const seen = new Set<string>();
    const uniq = changed.filter((s) => s?.entity_id && !seen.has(s.entity_id) && seen.add(s.entity_id));
    out.changed_states = uniq.slice(0, 50).map(actionState);
    if (uniq.length > 50) out.changed_states_truncated = uniq.length - 50;
  }
  return { ...out, ...extra };
}

export function hasIndirect(t: { area_id?: unknown; floor_id?: unknown; device_id?: unknown; label_id?: unknown }) {
  return [t.area_id, t.floor_id, t.device_id, t.label_id].some((v) => asArray(v as any).length > 0);
}
