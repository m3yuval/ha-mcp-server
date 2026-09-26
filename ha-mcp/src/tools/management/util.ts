import { HAError, type HAClient } from "../../ha-client.js";

export const CAP = "management" as const;

/** Drop undefined values so we only send fields the caller set. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** Throw a clear error when a required argument for an action is missing. */
export function need<T>(value: T | undefined | null, what: string, action: string): T {
  if (value === undefined || value === null || value === "") {
    throw new HAError(`'${what}' is required for action '${action}'`);
  }
  return value;
}

/** Make sure a value is safe to put into a URL path segment. */
export function pathId(id: string, what = "id"): string {
  if (!id || /[/?#\\]|\.\./.test(id)) throw new HAError(`Invalid ${what}: ${id}`);
  return encodeURIComponent(id);
}

/** Lowercase substring match on any of the given fields. */
export function matches(search: string | undefined, ...fields: unknown[]): boolean {
  if (!search) return true;
  const s = search.toLowerCase();
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(s));
}

export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "item";
}

/** Run a websocket command through the management capability. */
export function ws<T = unknown>(ha: HAClient, type: string, payload: Record<string, unknown> = {}) {
  return ha.ws<T>(type, payload, CAP);
}

// ------------------------------------------------------------ data entry flows

interface SchemaField {
  name: string;
  type?: string;
  required?: boolean;
  optional?: boolean;
  default?: unknown;
  description?: { suggested_value?: unknown };
  selector?: Record<string, unknown>;
  options?: unknown;
  valueMin?: number;
  valueMax?: number;
  schema?: SchemaField[];
  expanded?: boolean;
}

/**
 * Turn a serialized data_schema (voluptuous/probatio field list) into a compact,
 * readable list: name, type or selector, required, default, choices.
 */
export function describeSchema(schema: unknown, labels?: Record<string, string>): unknown[] {
  if (!Array.isArray(schema)) return [];
  return (schema as SchemaField[]).map((f) => {
    const o: Record<string, unknown> = { name: f.name };
    if (labels?.[f.name]) o.label = labels[f.name];
    if (f.type === "expandable") {
      o.type = "section";
      o.note = `Submit these fields nested under "${f.name}": { "${f.name}": { ... } }`;
      o.fields = describeSchema(f.schema, labels);
      return o;
    }
    o.required = Boolean(f.required);
    if (f.selector) {
      const [kind] = Object.keys(f.selector);
      o.type = kind;
      const cfg = (f.selector as Record<string, any>)[kind];
      if (cfg && typeof cfg === "object" && Object.keys(cfg).length) {
        if (kind === "select" && Array.isArray(cfg.options)) {
          o.choices = cfg.options.map((opt: any) => (typeof opt === "object" && opt ? opt.value : opt));
          if (cfg.multiple) o.multiple = true;
        } else {
          o.selector_options = cfg;
        }
      }
    } else if (f.type) {
      o.type = f.type;
    }
    if (f.options !== undefined) {
      o.choices = Array.isArray(f.options)
        ? f.options.map((x: any) => (Array.isArray(x) ? x[0] : x))
        : f.options && typeof f.options === "object"
          ? Object.keys(f.options as object)
          : f.options;
    }
    if (f.valueMin !== undefined) o.min = f.valueMin;
    if (f.valueMax !== undefined) o.max = f.valueMax;
    if (f.default !== undefined) o.default = f.default;
    if (f.description?.suggested_value !== undefined) o.current_value = f.description.suggested_value;
    return o;
  });
}

export type FlowKind = "config" | "options" | "repair";

/** Flatten nested translation resources: {a:{b:"x"}} -> {"a.b": "x"}. */
function flatten(obj: unknown, prefix = "", out: Record<string, string> = {}) {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof obj === "string") {
    out[prefix] = obj;
  }
  return out;
}

/**
 * Best-effort: fetch English UI strings for a flow step (field labels, step
 * description, error texts). Never fails the tool call.
 */
async function flowStrings(ha: HAClient, kind: FlowKind, domain: string) {
  try {
    const category = kind === "repair" ? "issues" : kind === "options" ? "options" : "config";
    const res = await ws<{ resources: Record<string, unknown> }>(ha, "frontend/get_translations", {
      language: "en",
      category,
      integration: [domain],
    });
    const flat = flatten(res?.resources ?? {});
    return { flat, prefix: `component.${domain}.${category}` };
  } catch {
    return undefined;
  }
}

/** Make a flow step result readable and tell the caller what to do next. */
export async function presentFlowStep(ha: HAClient, kind: FlowKind, step: any) {
  if (!step || typeof step !== "object") return step;
  const out: Record<string, unknown> = {
    flow: kind,
    type: step.type,
    flow_id: step.flow_id,
    handler: step.handler,
  };
  if (step.step_id) out.step_id = step.step_id;
  const domain = step.translation_domain ?? (kind === "config" ? step.handler : undefined);
  const strings = domain && typeof domain === "string" ? await flowStrings(ha, kind, domain) : undefined;
  const t = (key: string) => strings?.flat[`${strings.prefix}.${key}`];
  const stepKey = kind === "repair" ? `fix_flow.step.${step.step_id}` : `step.${step.step_id}`;
  const labels: Record<string, string> = {};
  if (strings && step.step_id) {
    const p = `${strings.prefix}.${stepKey}.data.`;
    for (const [k, v] of Object.entries(strings.flat)) if (k.startsWith(p)) labels[k.slice(p.length)] = v;
    const title = t(`${stepKey}.title`);
    const desc = t(`${stepKey}.description`);
    if (title) out.title = title;
    if (desc) out.description = desc;
  }
  if (step.description_placeholders && Object.keys(step.description_placeholders).length) {
    out.description_placeholders = step.description_placeholders;
  }
  switch (step.type) {
    case "form": {
      out.fields = describeSchema(step.data_schema, labels);
      if (step.errors && Object.keys(step.errors).length) {
        const errs: Record<string, string> = {};
        for (const [field, code] of Object.entries(step.errors as Record<string, string>)) {
          errs[field] = t(`error.${code}`) ? `${code}: ${t(`error.${code}`)}` : code;
        }
        out.errors = errs;
      }
      if (step.last_step !== undefined && step.last_step !== null) out.last_step = step.last_step;
      out.next =
        "Ask the user for the field values, then call ha_integration_flow with action='step', this flow_id and user_input={field: value}. Optional fields can be omitted.";
      break;
    }
    case "menu": {
      out.menu_options = step.menu_options;
      out.next = "Call ha_integration_flow with action='step' and user_input={\"next_step_id\": <one of menu_options>}.";
      break;
    }
    case "external_done":
    case "progress_done": {
      out.next = "Call ha_integration_flow action='step' with user_input={} to continue.";
      break;
    }
    case "external": {
      out.url = step.url;
      out.next = "The user must open the url and finish there, then call ha_integration_flow action='step' with user_input={} (or action='get').";
      break;
    }
    case "progress": {
      out.progress_action = step.progress_action;
      out.next = "Home Assistant is working. Call ha_integration_flow action='get' in a few seconds to see the next step.";
      break;
    }
    case "create_entry": {
      out.title = step.title;
      if (step.result && typeof step.result === "object") {
        const r = step.result as Record<string, unknown>;
        out.result = r.entry_id ? { entry_id: r.entry_id, domain: r.domain, title: r.title, state: r.state } : r;
      }
      if (step.next_flow) out.next_flow = step.next_flow;
      out.next = "Done.";
      break;
    }
    case "abort": {
      out.reason = step.reason;
      const text = t(`abort.${step.reason}`);
      if (text) out.reason_text = text;
      if (step.next_flow) out.next_flow = step.next_flow;
      break;
    }
    default:
      Object.assign(out, step);
  }
  return out;
}
