/**
 * Redaction of secret values in file content returned to the model.
 *
 * Only what is RETURNED is redacted (read output, diffs); files on disk are
 * never changed by redaction, and edits always operate on the real content.
 *
 *   - YAML / JSON files: the value of every mapping key that looks secret is
 *     replaced by "**REDACTED**", using the parser's source ranges so the rest
 *     of the file (comments, formatting, LINE NUMBERS) stays exactly as on disk.
 *     A multi-line value is replaced by the placeholder plus the same number of
 *     newlines. HA reference tags (!secret, !env_var, !include*, !input) are
 *     kept: they are names, not values.
 *   - .storage JSON (read-only): parsed and redacted structurally; in
 *     core.config_entries every value of an entry's data/options (and subentry
 *     data) is redacted, whatever its key.
 *   - Any other text file (and YAML that does not parse): line-based
 *     `key: value` / `key = value` masking with the same key rules.
 *   - Everywhere: credentials in URLs (scheme://user:PASSWORD@host).
 *
 * Secret key rule (case-insensitive, matched anywhere in the key name):
 *   SECRET_KEY_RE  password|passwd|passphrase|secret|token|api_?key|private|
 *                  credential|cookie|jwt|psk|webhook_id|cloudhook|ltsk|
 *                  network_key|encryption_key|bearer|session|(^|_)pin(_code)?$|
 *                  (^|_)pass$
 *   plus any key ending in "key" (e.g. `key`, `ext_key`, `aesKey`) when the value
 *   looks like key material: a 16+ char token of [A-Za-z0-9+/=_.:-], or a list
 *   of 8+ numbers/strings (Zigbee network keys).
 */
import YAML, { isAlias, isMap, isPair, isScalar, isSeq, type Node } from "yaml";
import path from "node:path";
import { HA_TAGS, PARSE_OPTIONS } from "./yaml-ha.js";

export const REDACTED = "**REDACTED**";
const PLACEHOLDER = JSON.stringify(REDACTED); // "\"**REDACTED**\"" valid in YAML and JSON

export const SECRET_KEY_RE =
  /password|passwd|passphrase|secret|token|api_?key|private|credential|cookie|jwt|psk|webhook_id|cloudhook|ltsk|network_key|encryption_key|bearer|session|(^|_)pin(_code)?$|(^|_)pass$/i;
const KEYLIKE_NAME_RE = /key$/i;
const KEYLIKE_VALUE_RE = /^[A-Za-z0-9+/=_.:-]{16,}$/;
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'{}]+:)([^\s@/"'{}]+)@/gi;

export interface Redacted {
  text: string;
  /** Key names whose values were redacted (deduplicated, in order of appearance). */
  keys: string[];
}

function looksLikeKeyMaterial(v: unknown): boolean {
  if (typeof v === "string") return KEYLIKE_VALUE_RE.test(v);
  if (Array.isArray(v)) return v.length >= 8 && v.every((x) => typeof x === "number" || typeof x === "string");
  return false;
}

/** Should the value of key `name` be hidden? `value` is the plain JS value. */
export function isSecretKey(name: string, value: unknown): boolean {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return false;
  if (value === REDACTED) return false;
  if (SECRET_KEY_RE.test(name)) return true;
  return KEYLIKE_NAME_RE.test(name) && looksLikeKeyMaterial(value);
}

function redactUrls(text: string, keys: Set<string>): string {
  return text.replace(URL_CRED_RE, (_m, pre: string) => {
    keys.add("(password in URL)");
    return `${pre}${REDACTED}@`;
  });
}

// ------------------------------------------------------------- JSON values

/** Deep copy of a JSON value with secret-looking keys' values replaced. */
export function redactJson(v: unknown, keys: Set<string> = new Set()): unknown {
  if (Array.isArray(v)) return v.map((x) => redactJson(x, keys));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (isSecretKey(k, val)) {
        out[k] = REDACTED;
        keys.add(k);
      } else out[k] = redactJson(val, keys);
    }
    return out;
  }
  if (typeof v === "string") return redactUrls(v, keys);
  return v;
}

function redactAllValues(obj: unknown, label: string, keys: Set<string>): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) out[k] = REDACTED;
  if (Object.keys(obj).length) keys.add(label);
  return out;
}

/** .storage file → redacted, pretty JSON. Throws if not JSON. */
export function redactStorage(rel: string, text: string): Redacted {
  const keys = new Set<string>();
  let data = JSON.parse(text);
  if (path.posix.basename(rel) === "core.config_entries" && Array.isArray(data?.data?.entries)) {
    data = { ...data, data: { ...data.data } };
    data.data.entries = data.data.entries.map((e: any) => {
      if (!e || typeof e !== "object") return e;
      const c = { ...e };
      if ("data" in c) c.data = redactAllValues(c.data, "entries[].data.*", keys);
      if ("options" in c) c.options = redactAllValues(c.options, "entries[].options.*", keys);
      if (Array.isArray(c.subentries)) {
        c.subentries = c.subentries.map((s: any) =>
          s && typeof s === "object" ? { ...s, data: redactAllValues(s.data, "entries[].subentries[].data.*", keys) } : s,
        );
      }
      return c;
    });
  }
  const red = redactJson(data, keys);
  return { text: JSON.stringify(red, null, 2) + "\n", keys: [...keys] };
}

// ------------------------------------------------------------- YAML / JSON source

function plain(node: unknown): unknown {
  if (isScalar(node)) return node.value;
  if (isSeq(node)) return node.items.map((i) => (isScalar(i) ? i.value : i));
  if (isMap(node)) return {}; // a mapping under a secret key: redact as a whole
  return undefined;
}

/**
 * Range-based redaction of YAML (JSON is YAML): returns null when the source
 * does not parse cleanly (caller falls back to line-based masking).
 */
function redactYamlSource(text: string, keys: Set<string>): string | null {
  const doc = YAML.parseDocument(text, { ...PARSE_OPTIONS, uniqueKeys: false });
  if (doc.errors.length) return null;
  const ranges: [number, number][] = [];
  YAML.visit(doc, {
    Pair(_k, pair) {
      if (!isPair(pair)) return;
      const k = isScalar(pair.key) ? String(pair.key.value) : null;
      const v = pair.value as Node | null;
      if (k === null || !v || isAlias(v) || !v.range) return;
      if (isScalar(v) && v.tag && HA_TAGS.includes(v.tag)) return; // !secret name etc.
      let value = plain(v);
      if (isMap(v) && v.items.length === 0) value = null;
      if (isSeq(v) && v.items.length === 0) value = null;
      if (!isSecretKey(k, value)) return;
      if (isMap(v) && !SECRET_KEY_RE.test(k)) return;
      ranges.push([v.range[0], v.range[1]]);
      keys.add(k);
      return YAML.visit.SKIP;
    },
  });
  ranges.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e] of ranges) {
    const slice = out.slice(s, e);
    const trail = /\s*$/.exec(slice)![0];
    const body = slice.slice(0, slice.length - trail.length);
    const nl = (body.match(/\n/g) ?? []).length;
    out = out.slice(0, s) + PLACEHOLDER + "\n".repeat(nl) + trail + out.slice(e);
  }
  return out;
}

const LINE_RE = /^(\s*(?:-\s+)?["']?)([A-Za-z0-9_.@-]+)(["']?\s*[:=]\s*)(\S.*?)(\s*,?\s*)$/;
const KEEP_VALUE_RE =
  /^(!secret|!env_var|!include\w*|!input)(\s|$)|^(true|false|null|yes|no|on|off|~|\{\}|\[\]|\{|\[)$|^[|>][-+0-9]*$|\*\*REDACTED\*\*/i;

/** Line-based `key: value` / `key = value` masking (any text, or YAML that does not parse). */
function redactLines(text: string, keys: Set<string>): string {
  return text
    .split("\n")
    .map((line) => {
      const m = LINE_RE.exec(line);
      if (!m) return line;
      const [, pre, key, sep, value, post] = m;
      if (KEEP_VALUE_RE.test(value.trim())) return line;
      if (!isSecretKey(key, value.replace(/^["']|["']$/g, ""))) return line;
      keys.add(key);
      return `${pre}${key}${sep}${PLACEHOLDER}${post}`;
    })
    .join("\n");
}

/**
 * Redact file content for display. `kind` picks the strategy: "storage" for
 * .storage JSON, "structured" for .yaml/.yml/.json, "text" for anything else.
 */
export function redactForDisplay(kind: "storage" | "structured" | "text", rel: string, text: string): Redacted {
  const keys = new Set<string>();
  let out: string;
  if (kind === "storage") return redactStorage(rel, text);
  if (kind === "structured") {
    out = redactYamlSource(text, keys) ?? redactLines(text, keys);
  } else {
    out = redactLines(text, keys);
  }
  out = redactUrls(out, keys);
  return { text: out, keys: [...keys] };
}
