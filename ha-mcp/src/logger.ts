/**
 * Small leveled logger. Writes to stderr (stdout is reserved for the MCP
 * stdio transport). Levels match Home Assistant add-on conventions.
 */

const LEVELS = ["trace", "debug", "info", "notice", "warning", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

let threshold = LEVELS.indexOf("info");

export function setLogLevel(level: string) {
  const i = LEVELS.indexOf(level.toLowerCase() as Level);
  threshold = i >= 0 ? i : LEVELS.indexOf("info");
}

function write(level: Level, msg: string) {
  if (LEVELS.indexOf(level) < threshold) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stderr.write(`${ts} ${level.toUpperCase().padEnd(7)} ${msg}\n`);
}

export const log = {
  trace: (m: string) => write("trace", m),
  debug: (m: string) => write("debug", m),
  info: (m: string) => write("info", m),
  notice: (m: string) => write("notice", m),
  warning: (m: string) => write("warning", m),
  error: (m: string) => write("error", m),
};

const SECRET_KEY = /token|password|passwd|secret|api_?key|authorization|credential/i;

/** Compact, secret-redacted one-line JSON for logs. */
export function summarize(value: unknown, max = 300): string {
  let text: string;
  try {
    text = JSON.stringify(value, (k, v) => (k && SECRET_KEY.test(k) ? "***" : v));
  } catch {
    text = String(value);
  }
  if (text === undefined) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
