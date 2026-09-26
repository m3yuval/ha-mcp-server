/**
 * YAML helpers that understand Home Assistant's dialect:
 *   - HA custom tags (!include, !include_dir_*, !secret, !env_var, !input) are
 *     accepted and kept verbatim, so validation does not fail on them and
 *     round-trips preserve them.
 *   - Edits use the `yaml` Document API, which keeps comments, quoting and
 *     key order.
 *   - secrets.yaml can be redacted for display (all other redaction: redact.ts).
 */
import YAML, { isMap, isScalar, isSeq, Scalar, type Document, type Node } from "yaml";
import path from "node:path";
import { HAError } from "../../ha-client.js";

export const INCLUDE_TAGS = [
  "!include",
  "!include_dir_list",
  "!include_dir_named",
  "!include_dir_merge_list",
  "!include_dir_merge_named",
];
export const HA_TAGS = [...INCLUDE_TAGS, "!secret", "!env_var", "!input"];

const customTags = HA_TAGS.map((tag) => ({
  tag,
  resolve: (str: string) => str,
  identify: () => false,
}));

export const PARSE_OPTIONS = { customTags, prettyErrors: true } as const;

export interface Issue {
  message: string;
  line?: number;
  column?: number;
}

export interface Validation {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
}

function issue(e: { message: string; linePos?: [{ line: number; col: number }, ...unknown[]] | any }): Issue {
  const pos = Array.isArray(e.linePos) ? e.linePos[0] : undefined;
  // prettyErrors appends a code excerpt; keep only the first line of the message.
  const message = e.message.split("\n")[0];
  return pos ? { message, line: pos.line, column: pos.col } : { message };
}

export function parseYaml(text: string): { doc: Document.Parsed; errors: Issue[]; warnings: Issue[] } {
  const doc = YAML.parseDocument(text, PARSE_OPTIONS);
  const errors = doc.errors.map(issue);
  const warnings = doc.warnings.map((w) => {
    const i = issue(w);
    if (w.code === "TAG_RESOLVE_FAILED") i.message += " (not a Home Assistant tag; HA will likely fail to load this)";
    return i;
  });
  return { doc, errors, warnings };
}

/** Collect `!include*` and `!secret` references (for hints). */
export function collectRefs(doc: Document) {
  const includes: { tag: string; target: string }[] = [];
  const secrets: string[] = [];
  YAML.visit(doc, {
    Scalar(_k, node) {
      if (!node.tag) return;
      if (INCLUDE_TAGS.includes(node.tag)) includes.push({ tag: node.tag, target: String(node.value).trim() });
      else if (node.tag === "!secret") secrets.push(String(node.value).trim());
    },
  });
  return { includes, secrets };
}

/** Shape checks for the well-known UI-managed files. */
function structuralWarnings(rel: string, doc: Document): Issue[] {
  const name = path.posix.basename(rel).toLowerCase();
  const root = doc.contents;
  const out: Issue[] = [];
  const empty = root === null || (isScalar(root) && (root.value === null || root.value === ""));
  if (name === "configuration.yaml" && !empty && !isMap(root)) {
    out.push({ message: "configuration.yaml should be a mapping of integration names" });
  }
  if (name === "automations.yaml" || name === "scenes.yaml") {
    if (!empty && !isSeq(root)) {
      out.push({ message: `${name} is loaded as a list (- id: ...) by the default '!include ${name}'; this file is not a list` });
    } else if (isSeq(root)) {
      const seen = new Set<string>();
      root.items.forEach((item, i) => {
        if (!isMap(item)) return;
        const id = item.get("id");
        if (id === undefined || id === null || id === "") {
          out.push({ message: `Item ${i} has no 'id': the UI editor cannot edit it` });
        } else if (seen.has(String(id))) {
          out.push({ message: `Duplicate id '${id}' (item ${i}); ids must be unique` });
        } else seen.add(String(id));
      });
    }
  }
  if (name === "scripts.yaml" && !empty && !isMap(root)) {
    out.push({ message: "scripts.yaml is loaded as a mapping of script_id: {...}; this file is not a mapping" });
  }
  return out;
}

/**
 * V8's JSON.parse messages can quote a snippet of the input
 * (`Unexpected token 'x', ..."password": "x"... is not valid JSON`); drop any
 * quoted text so an error never echoes (possibly secret) file content.
 */
export function sanitizeJsonError(msg: string): string {
  return msg.replace(/,\s*(\.\.\.)?".*"(\.\.\.)?\s+is not valid JSON/s, " (not valid JSON)").replace(/"[^"]*"/g, '"…"');
}

/** Validate text for a given file by extension. */
export function validate(rel: string, text: string): Validation & { doc?: Document.Parsed } {
  if (/\.ya?ml$/i.test(rel)) {
    const { doc, errors, warnings } = parseYaml(text);
    if (errors.length === 0) warnings.push(...structuralWarnings(rel, doc));
    return { valid: errors.length === 0, errors, warnings, doc };
  }
  if (/\.json$/i.test(rel)) {
    try {
      if (text.trim() !== "") JSON.parse(text);
      return { valid: true, errors: [], warnings: [] };
    } catch (e) {
      return { valid: false, errors: [{ message: `Invalid JSON: ${sanitizeJsonError((e as Error).message)}` }], warnings: [] };
    }
  }
  return { valid: true, errors: [], warnings: [] };
}

// ------------------------------------------------------------- redaction

/**
 * Redact a secrets.yaml: keep keys and comments, replace every value with "***".
 * Returns null if it does not parse (then nothing of it may be shown).
 */
export function redactSecretsYaml(text: string): { text: string; names: string[] } | null {
  const doc = YAML.parseDocument(text, PARSE_OPTIONS);
  if (doc.errors.length) return null;
  YAML.visit(doc, {
    Scalar(key, node) {
      if (key !== "key") {
        node.value = "***";
        node.tag = undefined;
      }
    },
    Alias(key) {
      if (key !== "key") return new Scalar("***");
    },
  });
  const names = isMap(doc.contents) ? doc.contents.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key)) : [];
  return { text: doc.toString({ lineWidth: 0 }), names };
}

export function secretNames(text: string): string[] {
  const doc = YAML.parseDocument(text, PARSE_OPTIONS);
  if (doc.errors.length || !isMap(doc.contents)) return [];
  return doc.contents.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
}

// ------------------------------------------------------------- paths & edits

export type PathSeg = string | number;

/**
 * Parse a YAML path. Accepts an array (["homeassistant", "customize", "light.kitchen"])
 * or a string with dots and brackets: `homeassistant.customize["light.kitchen"].friendly_name`,
 * `automation[0].alias`. Keys that contain dots (entity ids) must be bracket-quoted in the
 * string form.
 */
export function parsePath(p: string | PathSeg[]): PathSeg[] {
  if (Array.isArray(p)) {
    if (p.length === 0) throw new HAError("YAML path must not be empty");
    return p;
  }
  const segs: PathSeg[] = [];
  let i = 0;
  const s = p.trim();
  if (!s) throw new HAError("YAML path must not be empty");
  while (i < s.length) {
    const c = s[i];
    if (c === ".") {
      i++;
      continue;
    }
    if (c === "[") {
      const q = s[i + 1];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q + "]", i + 2);
        if (end < 0) throw new HAError(`Unclosed quote in YAML path: ${p}`);
        segs.push(s.slice(i + 2, end));
        i = end + 2;
      } else {
        const end = s.indexOf("]", i);
        if (end < 0) throw new HAError(`Unclosed [ in YAML path: ${p}`);
        const inner = s.slice(i + 1, end).trim();
        if (!/^\d+$/.test(inner)) throw new HAError(`List index must be a number (quote map keys): [${inner}]`);
        segs.push(Number(inner));
        i = end + 1;
      }
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== "." && s[j] !== "[") j++;
    segs.push(s.slice(i, j));
    i = j;
  }
  return segs;
}

export interface YamlOp {
  path: string | PathSeg[];
  action: "set" | "delete";
  value?: unknown;
  value_yaml?: string;
}

/** Detect whether the file indents block sequences under their key (HA-written files don't). */
function detectIndentSeq(text: string): boolean {
  const lines = text.split("\n");
  let indented = 0;
  let flush = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const m = /^(\s*)[^\s#-][^#]*:\s*(#.*)?$/.exec(lines[i]);
    if (!m) continue;
    const next = /^(\s*)- /.exec(lines[i + 1]);
    if (!next) continue;
    if (next[1].length === m[1].length) flush++;
    else if (next[1].length > m[1].length) indented++;
  }
  return flush > indented ? false : true;
}

export function stringifyDoc(doc: Document, original: string): string {
  const out = doc.toString({ lineWidth: 0, indentSeq: detectIndentSeq(original), flowCollectionPadding: false });
  return original.endsWith("\n") || original === "" ? out : out.replace(/\n$/, "");
}

/** Apply set/delete operations with the Document API (comments and formatting preserved). */
export function applyYamlOps(text: string, ops: YamlOp[]): string {
  const { doc, errors } = parseYaml(text);
  if (errors.length) {
    throw new HAError(`Cannot apply YAML-path edits: the file does not parse (${errors[0].message}${errors[0].line ? ` at line ${errors[0].line}` : ""})`);
  }
  for (const op of ops) {
    const segs = parsePath(op.path);
    const label = segs.map((s) => (typeof s === "number" ? `[${s}]` : s)).join(" > ");
    if (op.action === "delete") {
      let removed = false;
      try {
        if (!doc.hasIn(segs)) throw new Error("path not found");
        removed = doc.deleteIn(segs);
      } catch (e) {
        throw new HAError(`Cannot delete ${label}: ${(e as Error).message}`);
      }
      if (!removed) throw new HAError(`Cannot delete ${label}: path not found`);
      continue;
    }
    let node: unknown;
    if (op.value_yaml !== undefined) {
      const v = parseYaml(op.value_yaml);
      if (v.errors.length) throw new HAError(`value_yaml for ${label} does not parse: ${v.errors[0].message}`);
      node = v.doc.contents;
    } else if (op.value !== undefined) {
      node = doc.createNode(op.value);
    } else {
      throw new HAError(`'set' on ${label} needs value or value_yaml`);
    }
    // Refuse to walk through a scalar (setIn would throw a cryptic error).
    let cur: unknown = doc.contents;
    for (let i = 0; i < segs.length - 1 && cur; i++) {
      if (isMap(cur) || isSeq(cur)) cur = (cur as any).get(segs[i], true);
      else throw new HAError(`Cannot set ${label}: '${segs.slice(0, i).join(".")}' is not a mapping or list`);
    }
    if (cur && !isMap(cur) && !isSeq(cur)) {
      throw new HAError(`Cannot set ${label}: parent is a scalar value, not a mapping or list`);
    }
    if (isSeq(cur) && typeof segs[segs.length - 1] !== "number") {
      throw new HAError(`Cannot set ${label}: parent is a list, use a numeric index`);
    }
    try {
      doc.setIn(segs, node as Node);
    } catch (e) {
      throw new HAError(`Cannot set ${label}: ${(e as Error).message}`);
    }
  }
  return stringifyDoc(doc, text);
}

/** Exact string replacement like a code editor's str_replace. */
export function strReplace(text: string, oldStr: string, newStr: string, all: boolean): { text: string; count: number } {
  if (oldStr === "") throw new HAError("old_string must not be empty");
  const positions: number[] = [];
  for (let i = text.indexOf(oldStr); i >= 0; i = text.indexOf(oldStr, i + oldStr.length)) positions.push(i);
  if (positions.length === 0) {
    throw new HAError(
      "old_string was not found in the file. It must match exactly, including indentation and whitespace. Read the file again and copy the text.",
    );
  }
  if (positions.length > 1 && !all) {
    const lines = positions.map((p) => text.slice(0, p).split("\n").length);
    throw new HAError(
      `old_string matches ${positions.length} times (lines ${lines.join(", ")}). Include more surrounding lines so it is unique, or set replace_all.`,
    );
  }
  return { text: text.split(oldStr).join(newStr), count: positions.length };
}

/** Set (add/update) a key in secrets.yaml text, preserving comments. */
export function setSecret(text: string, name: string, value: string): { text: string; existed: boolean } {
  const { doc, errors } = parseYaml(text);
  if (errors.length) throw new HAError(`secrets.yaml does not parse (line ${errors[0].line ?? "?"}); fix it first`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new HAError("secrets.yaml is not a mapping");
  const existed = doc.has(name);
  const node = new Scalar(value);
  node.type = Scalar.QUOTE_DOUBLE; // always a string, never coerced to a number/bool
  doc.set(name, node);
  return { text: stringifyDoc(doc, text || "\n"), existed };
}

export function deleteSecret(text: string, name: string): { text: string; existed: boolean } {
  const { doc, errors } = parseYaml(text);
  if (errors.length) throw new HAError(`secrets.yaml does not parse (line ${errors[0].line ?? "?"}); fix it first`);
  const existed = doc.delete(name);
  return { text: stringifyDoc(doc, text), existed };
}
