import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Config } from "../config.js";
import { HAClient, HAError } from "../ha-client.js";
import { log, summarize } from "../logger.js";

/** Everything a tool module needs. */
export interface ToolContext {
  server: McpServer;
  ha: HAClient;
  config: Config;
}

/** Max characters returned by a single tool call, to keep responses usable. */
export const MAX_OUTPUT_CHARS = 60_000;

export interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Reads: never change anything. */
export const READ_ONLY: Annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Changes state but can be undone / is not data-destroying (e.g. turn on a light). */
export const WRITE: Annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Can destroy data or disrupt the system (delete, restart, uninstall, overwrite). */
export const DESTRUCTIVE: Annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function ok(data: unknown) {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text === undefined) text = "OK";
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + `\n\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars — narrow the query]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  const msg = err instanceof HAError || err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/** Arguments that can hold whole file contents: logged as a size, never as text. */
const BULKY_ARG_KEYS = new Set(["content", "replacements", "old_string", "new_string", "old_text", "new_text", "config"]);

function argsForLog(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = BULKY_ARG_KEYS.has(k) && v !== undefined ? `<${JSON.stringify(v)?.length ?? 0} chars>` : v;
  }
  return out;
}

/**
 * Register a tool. Every tool in this server MUST be registered through this
 * function: it logs each call (name, redacted args, duration, result) at INFO
 * and turns thrown errors into MCP tool errors.
 *
 * The handler returns plain data (object/array/string); it is serialized here.
 */
export function defineTool<Shape extends ZodRawShape>(
  ctx: ToolContext,
  name: string,
  spec: { title: string; description: string; inputSchema: Shape; annotations: Annotations },
  handler: (args: any) => Promise<unknown>,
) {
  ctx.server.registerTool(name, spec as any, (async (args: any) => {
    const started = Date.now();
    try {
      const result = await handler(args ?? {});
      log.info(`tool ${name} ${summarize(argsForLog(args))} -> ok (${Date.now() - started}ms)`);
      return ok(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warning(`tool ${name} ${summarize(argsForLog(args))} -> error (${Date.now() - started}ms): ${msg.slice(0, 300)}`);
      return fail(err);
    }
  }) as any);
}

// ---------------------------------------------------------------- helpers

export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export function compactState(s: HAState) {
  const a = s.attributes ?? {};
  const out: Record<string, unknown> = { entity_id: s.entity_id, state: s.state };
  if (a.friendly_name) out.name = a.friendly_name;
  if (a.unit_of_measurement) out.unit = a.unit_of_measurement;
  if (a.device_class) out.device_class = a.device_class;
  out.last_changed = s.last_changed;
  return out;
}

export function isoHoursAgo(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

/** Render a template that outputs JSON (… | tojson) and parse it. */
export async function renderJson<T>(ha: HAClient, template: string): Promise<T> {
  const raw = await ha.renderTemplate(template);
  try {
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as T;
  } catch {
    throw new HAError(`Unexpected template output: ${String(raw).slice(0, 200)}`);
  }
}

/** Escape a value for safe use inside a single-quoted Jinja string literal. */
export function jinjaStr(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
