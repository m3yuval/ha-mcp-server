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
  // One event = one line: control characters (newlines etc.) can't forge extra log lines.
  const clean = msg.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => (c === "\n" ? "⏎" : "�"));
  process.stderr.write(`${ts} ${level.toUpperCase().padEnd(7)} ${clean}\n`);
}

export const log = {
  trace: (m: string) => write("trace", m),
  debug: (m: string) => write("debug", m),
  info: (m: string) => write("info", m),
  notice: (m: string) => write("notice", m),
  warning: (m: string) => write("warning", m),
  error: (m: string) => write("error", m),
};

// Argument names whose values are never logged. `code`/`pin` cover alarm and lock codes.
const SECRET_KEY =
  /token|password|passwd|passphrase|secret|api_?key|authorization|credential|private|psk|webhook|cookie|bearer|^(code|pin|pin_code|pass)$|_code$|_pin$/i;

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
