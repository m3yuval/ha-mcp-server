/**
 * YAML config file tools (capability: config).
 *
 * Registered only when ENABLE_CONFIG_FILES=true and CONFIG_DIR is set.
 *
 * Safety model (see config-files/sandbox.ts for details):
 *   - Every path is resolved inside CONFIG_DIR (realpath, no `..`, no symlink escapes).
 *   - Writes: only text types (.yaml .yml .json .txt .md .jinja .j2, .py in
 *     python_scripts/), never .storage/, databases, logs, or the backup folder.
 *   - YAML/JSON is validated before writing (HA tags understood); invalid
 *     content is refused unless force=true.
 *   - Writes are atomic (temp file + rename) and the previous version is kept in
 *     .ha-mcp-backups/ (last 20 per file). Deletes move the file there.
 *   - secrets.yaml values are never returned, diffed or accepted through the
 *     generic tools: use ha_set_secret / ha_delete_secret (the value argument
 *     is named secret_value so request logs redact it).
 *   - Credential files (.ssh/, private keys, service-account/OAuth JSON, token
 *     files, .cloud/, logs, databases) are never read, written or listed
 *     (sandbox.ts sensitiveReason).
 *   - .storage/ is read-only and only an allowlist of files is readable
 *     (sandbox.ts STORAGE_READABLE); core.config_entries data/options hidden.
 *   - Every file read is redacted for display (config-files/redact.ts): values
 *     of secret-looking keys and URL passwords become "**REDACTED**". Diffs are
 *     computed between redacted views. Edits always act on the real file, and
 *     writing the placeholder back is refused.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { HAError } from "../ha-client.js";
import { DESTRUCTIVE, READ_ONLY, WRITE, defineTool, type ToolContext } from "./common.js";
import { Backups, MAX_BACKUPS } from "./config-files/backups.js";
import { diffStats, unifiedDiff } from "./config-files/diff.js";
import {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  Sandbox,
  WRITABLE_EXTENSIONS,
  atomicWrite,
  globToRegExp,
  isSecretStoreFile,
  isSecretsFile,
  isStorage,
  isYaml,
  listFiles,
  looksBinary,
  readText,
  type Resolved,
} from "./config-files/sandbox.js";
import {
  applyYamlOps,
  collectRefs,
  deleteSecret,
  redactSecretsYaml,
  secretNames,
  setSecret,
  strReplace,
  validate,
  type Issue,
  type YamlOp,
} from "./config-files/yaml-ha.js";
import { REDACTED, redactForDisplay } from "./config-files/redact.js";

function displayKind(rel: string): "storage" | "structured" | "text" {
  if (isStorage(rel)) return "storage";
  return isYaml(rel) || /\.json$/i.test(rel) ? "structured" : "text";
}

const REDACTION_NOTE =
  `Values of secret-looking keys are shown as "${REDACTED}" (the file on disk is unchanged). ` +
  `Edits apply to the real file: do not put "${REDACTED}" in old_string/new_string; ` +
  "target those lines with yaml_operations, or keep secrets in secrets.yaml (ha_set_secret) and reference them with !secret.";

/** Max characters of file content returned by one read (the response cap is 60k). */
const READ_CHUNK_CHARS = 50_000;

/** Reload targets → service. "all" reloads every YAML integration that supports it. */
const RELOADS: Record<string, [string, string]> = {
  all: ["homeassistant", "reload_all"],
  core: ["homeassistant", "reload_core_config"],
  custom_templates: ["homeassistant", "reload_custom_templates"],
  automation: ["automation", "reload"],
  script: ["script", "reload"],
  scene: ["scene", "reload"],
  group: ["group", "reload"],
  template: ["template", "reload"],
  input_boolean: ["input_boolean", "reload"],
  input_button: ["input_button", "reload"],
  input_datetime: ["input_datetime", "reload"],
  input_number: ["input_number", "reload"],
  input_select: ["input_select", "reload"],
  input_text: ["input_text", "reload"],
  timer: ["timer", "reload"],
  counter: ["counter", "reload"],
  schedule: ["schedule", "reload"],
  zone: ["zone", "reload"],
  person: ["person", "reload"],
  python_script: ["python_script", "reload"],
  command_line: ["command_line", "reload"],
  rest: ["rest", "reload"],
  mqtt: ["mqtt", "reload"],
};
const RELOAD_KEYS = Object.keys(RELOADS) as [string, ...string[]];

/** Well-known files, returned as hints by the list tool. */
const WELL_KNOWN: Record<string, string> = {
  "configuration.yaml": "Main config. Changes to most integrations need a reload or restart.",
  "automations.yaml": "UI-managed automations (a list; each item needs a unique 'id'). Reload: automation.",
  "scripts.yaml": "UI-managed scripts (a mapping of script_id). Reload: script.",
  "scenes.yaml": "UI-managed scenes (a list with 'id'). Reload: scene.",
  "customize.yaml": "Entity customizations (homeassistant.customize). Reload: core.",
  "groups.yaml": "Old-style groups. Reload: group.",
  "secrets.yaml": "Secret values for !secret. Values are never shown; use ha_set_secret.",
};

function sha256(data: string | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

function suggestedReload(rel: string): string {
  const base = path.posix.basename(rel).toLowerCase();
  const first = rel.split("/")[0];
  if (base === "automations.yaml" || first === "automations") return "automation";
  if (base === "scripts.yaml" || first === "scripts") return "script";
  if (base === "scenes.yaml" || first === "scenes") return "scene";
  if (base === "groups.yaml") return "group";
  if (base.startsWith("customize")) return "core";
  if (base === "templates.yaml" || first === "templates") return "template";
  if (first === "custom_templates") return "custom_templates";
  if (first === "python_scripts") return "python_script";
  if (isSecretsFile(rel)) return "reload the integrations that use the changed secret (or 'all'); some need a restart";
  return "run ha_check_config, then reload the affected integration (or 'all'); some integrations only apply changes after a restart";
}

const lineCount = (t: string) => (t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0));

export function registerConfigFileTools(ctx: ToolContext) {
  const { ha } = ctx;
  const sandbox = new Sandbox(ctx.config.configDir!);
  let backupsPromise: Promise<Backups> | undefined;
  const backups = () => (backupsPromise ??= sandbox.root().then((r) => new Backups(r)));

  /** Secret names visible from a file: secrets.yaml in its folder, then parents up to the config dir. */
  async function secretsVisibleFrom(rel: string): Promise<Set<string> | null> {
    const root = await sandbox.root();
    let dir = path.posix.dirname(rel);
    const names = new Set<string>();
    let found = false;
    for (;;) {
      const file = path.join(root, dir === "." ? "" : dir, "secrets.yaml");
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (text !== null) {
        found = true;
        for (const n of secretNames(text)) names.add(n);
      }
      if (dir === "." || dir === "") break;
      dir = path.posix.dirname(dir);
    }
    return found ? names : null;
  }

  /** Extra warnings for YAML: missing !include targets, undefined !secret names. */
  async function refWarnings(rel: string, doc: Parameters<typeof collectRefs>[0]): Promise<Issue[]> {
    const out: Issue[] = [];
    const { includes, secrets } = collectRefs(doc);
    const dir = path.posix.dirname(rel);
    for (const inc of includes) {
      const target = path.posix.join(dir === "." ? "" : dir, inc.target);
      try {
        const r = await sandbox.resolve(target);
        const wantDir = inc.tag !== "!include";
        if (!r.exists) out.push({ message: `${inc.tag} ${inc.target}: ${wantDir ? "directory" : "file"} does not exist (yet)` });
        else if (wantDir && !r.isDir) out.push({ message: `${inc.tag} ${inc.target}: not a directory` });
        else if (!wantDir && !r.isFile) out.push({ message: `${inc.tag} ${inc.target}: not a file` });
      } catch (e) {
        out.push({ message: `${inc.tag} ${inc.target}: ${(e as Error).message}` });
      }
    }
    if (secrets.length && !isSecretsFile(rel)) {
      const names = await secretsVisibleFrom(rel);
      const missing = [...new Set(secrets)].filter((s) => !names?.has(s));
      if (missing.length) out.push({ message: `!secret not defined in secrets.yaml: ${missing.join(", ")} (add with ha_set_secret)` });
    }
    return out;
  }

  async function fullValidation(rel: string, text: string) {
    const v = validate(rel, text);
    const warnings = [...v.warnings];
    if (v.valid && v.doc) warnings.push(...(await refWarnings(rel, v.doc)));
    return { valid: v.valid, errors: v.errors, warnings };
  }

  async function readExisting(r: Resolved): Promise<Buffer | null> {
    if (!r.exists) return null;
    if ((r.size ?? 0) > MAX_READ_BYTES) throw new HAError(`Existing file is too large (${r.size} bytes)`);
    const buf = await fs.readFile(r.abs);
    if (looksBinary(buf)) throw new HAError(`Refusing: ${r.rel} looks binary`);
    return buf;
  }

  /**
   * Validate, back up, and atomically write new content. Returns a summary with a diff.
   * `secret` = true for secrets.yaml: no diff/content is returned.
   */
  async function commit(
    r: Resolved,
    newText: string,
    opts: { force?: boolean; expectedSha?: string; dryRun?: boolean; secret?: boolean; oldBuf?: Buffer | null },
  ) {
    const bytes = Buffer.byteLength(newText, "utf8");
    if (bytes > MAX_WRITE_BYTES) throw new HAError(`Content is too large (${bytes} bytes, max ${MAX_WRITE_BYTES})`);
    const oldBuf = opts.oldBuf !== undefined ? opts.oldBuf : await readExisting(r);
    if (opts.expectedSha && sha256(oldBuf ?? "") !== opts.expectedSha) {
      throw new HAError(`${r.rel} changed since it was read (sha256 mismatch). Read it again and redo the change.`);
    }
    const validation = opts.secret ? { ...validate(r.rel, newText), doc: undefined } : await fullValidation(r.rel, newText);
    if (!validation.valid && !opts.force) {
      const errs = validation.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join("; ");
      throw new HAError(`Refusing to write invalid ${isYaml(r.rel) ? "YAML" : "content"} to ${r.rel}: ${errs}. Fix it, or pass force=true to write anyway.`);
    }
    const oldText = oldBuf?.toString("utf8") ?? "";
    // Writing the display placeholder back would silently destroy the real secret.
    const count = (t: string) => t.split(REDACTED).length - 1;
    if (count(newText) > count(oldText)) {
      throw new HAError(`Refusing to write "${REDACTED}" into ${r.rel}: it is a display placeholder, not the real value. ${REDACTION_NOTE}`);
    }
    const result: Record<string, unknown> = { path: r.rel };
    if (oldBuf && oldText === newText) {
      return { ...result, changed: false, note: "Content is identical; nothing written." };
    }
    // The diff is computed between the REDACTED views of old and new content
    // (line numbers are preserved by redaction), so it never shows secret values.
    let diff: string | undefined;
    let redactedKeys: string[] = [];
    let secretOnlyChange = false;
    if (!opts.secret) {
      const kind = displayKind(r.rel);
      const ro = redactForDisplay(kind, r.rel, oldText);
      const rn = redactForDisplay(kind, r.rel, newText);
      redactedKeys = [...new Set([...ro.keys, ...rn.keys])];
      diff = unifiedDiff(ro.text, rn.text, r.rel);
      secretOnlyChange = diff === "" && oldText !== newText;
    }
    const summary = {
      ...result,
      action: oldBuf ? "updated" : "created",
      valid: validation.valid,
      ...(validation.valid ? {} : { forced: true, errors: validation.errors }),
      ...(validation.warnings.length ? { warnings: validation.warnings } : {}),
      ...(diff !== undefined ? { diff_stats: diffStats(diff), diff } : {}),
      ...(redactedKeys.length ? { redacted_keys: redactedKeys, redaction_note: "Secret values are masked in the diff." } : {}),
      ...(secretOnlyChange ? { note_redacted_change: "Only redacted (secret) values or formatting inside them changed." } : {}),
    };
    if (opts.dryRun) return { ...summary, dry_run: true, note: "Preview only; nothing written." };
    let backup_id: string | undefined;
    if (oldBuf) backup_id = await (await backups()).save(r.rel, oldBuf);
    await atomicWrite(r.abs, newText, undefined, await sandbox.root());
    return {
      ...summary,
      ...(backup_id ? { backup_id } : {}),
      sha256: opts.secret ? undefined : sha256(newText),
      next_step: `Reload to apply: ${suggestedReload(r.rel)} (ha_reload_config).`,
    };
  }

  // ------------------------------------------------------------------ list

  defineTool(
    ctx,
    "ha_list_config_files",
    {
      title: "List Home Assistant config files",
      description:
        "List YAML files in the Home Assistant config directory (recursively), with size and modification time. " +
        "Paths are relative to the config dir; use them with the other ha_*config_file tools. " +
        "By default skips big/internal folders (.storage, deps, tts, .cloud, backups, www, media, custom_components) and databases/logs; " +
        "set include_system to include them, include_all_text for non-YAML text files (.json, .jinja, .py, .txt, ...). " +
        "pattern is a glob (e.g. 'packages/**/*.yaml', '*.yaml' matches file names at any depth).",
      inputSchema: {
        path: z.string().optional().describe("Sub-folder to list, relative to the config dir (default: the whole config dir)"),
        pattern: z.string().optional().describe("Glob filter. Without '/' it matches file names; with '/' the relative path"),
        max_depth: z.number().int().min(1).max(20).default(8).describe("How many folder levels to descend"),
        include_all_text: z.boolean().default(false).describe("Also list non-YAML text files (json, jinja, py, txt, md, ...)"),
        include_system: z.boolean().default(false).describe("Also descend into .storage, custom_components, www, deps, ..."),
        limit: z.number().int().min(1).max(2000).default(500),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      const root = await sandbox.root();
      const start = await sandbox.resolve(a.path ?? ".");
      if (!start.exists || !start.isDir) throw new HAError(`Not a folder: ${a.path}`);
      if (start.rel.split("/")[0] === ".ha-mcp-backups") throw new HAError("Use ha_list_config_backups for backups");
      const pattern = a.pattern?.trim();
      const res = await listFiles(root, start.abs, {
        maxDepth: a.max_depth,
        match: pattern ? globToRegExp(pattern) : undefined,
        matchBasename: pattern ? !pattern.includes("/") : false,
        includeSystem: a.include_system || isStorage(start.rel),
        allText: a.include_all_text || isStorage(start.rel),
        limit: a.limit,
      });
      const hints = Object.fromEntries(
        Object.entries(WELL_KNOWN).filter(([f]) => res.files.some((x) => x.path === f)),
      );
      return {
        count: res.files.length,
        truncated: res.truncated || undefined,
        files: res.files,
        ...(res.skipped_dirs.length ? { skipped_dirs: res.skipped_dirs } : {}),
        ...(Object.keys(hints).length ? { well_known: hints } : {}),
      };
    },
  );

  // ------------------------------------------------------------------ read

  defineTool(
    ctx,
    "ha_read_config_file",
    {
      title: "Read a Home Assistant config file",
      description:
        "Read a text file from the Home Assistant config directory (e.g. 'configuration.yaml', 'packages/lights.yaml'). " +
        "Optional 1-based line range for big files. YAML files also get a parse check (errors with line numbers, " +
        "missing !include targets, undefined !secret names). Returns sha256 of the whole file; pass it as expected_sha256 " +
        "when writing to avoid overwriting concurrent changes. " +
        "secrets.yaml: only key names are shown, values are replaced by ***. In other files the values of secret-looking keys " +
        `(password, token, api_key, private_key, network_key, webhook_id, ...) and passwords in URLs are shown as "${REDACTED}"; ` +
        "redacted_keys lists them. Line numbers match the file on disk. .storage/: only registries, core.config, core.config_entries " +
        "(data/options hidden), lovelace*, helpers, person, zone and energy are readable (read-only). " +
        "Credential files (.ssh, keys/certs private parts, service accounts, tokens, .cloud, logs, databases) are refused.",
      inputSchema: {
        path: z.string().describe("File path relative to the config dir, e.g. 'automations.yaml'"),
        start_line: z.number().int().min(1).optional().describe("First line to return (1-based)"),
        end_line: z.number().int().min(1).optional().describe("Last line to return (inclusive)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      const r = await sandbox.resolve(a.path);
      sandbox.assertReadable(r);
      let text = await readText(r.abs);
      const meta: Record<string, unknown> = {
        path: r.rel,
        size: r.size,
        modified: new Date(r.mtimeMs ?? 0).toISOString(),
      };
      let check: unknown;
      if (isSecretStoreFile(r.rel)) {
        // secrets.yaml (and Zigbee2MQTT's secret.yaml): every value is hidden.
        const red = redactSecretsYaml(text);
        if (!red) {
          const v = validate(r.rel, text);
          return { ...meta, redacted: true, valid: false, errors: v.errors, note: `${path.posix.basename(r.rel)} does not parse; its content is not shown.` };
        }
        text = red.text;
        meta.redacted = true;
        meta.secret_names = red.names;
        meta.note = isSecretsFile(r.rel)
          ? "Values are hidden. Use ha_set_secret to add or change a secret."
          : "Values are hidden. This file cannot be changed with the file tools.";
      } else if (isStorage(r.rel)) {
        let red;
        try {
          red = redactForDisplay("storage", r.rel, text);
        } catch {
          throw new HAError(`${r.rel} is not valid JSON; refusing to show it unredacted`);
        }
        text = red.text;
        meta.redacted = true;
        if (red.keys.length) meta.redacted_keys = red.keys;
        meta.read_only = true;
        meta.note = ".storage is managed by Home Assistant. Change these settings through the UI/API, not by editing the file. Secret values are shown as " + JSON.stringify(REDACTED) + ".";
      } else {
        meta.sha256 = sha256(await fs.readFile(r.abs));
        if (isYaml(r.rel) || /\.json$/i.test(r.rel)) check = await fullValidation(r.rel, text);
        const red = redactForDisplay(displayKind(r.rel), r.rel, text);
        if (red.keys.length) {
          text = red.text;
          meta.redacted = true;
          meta.redacted_keys = red.keys;
          meta.note = REDACTION_NOTE;
        }
      }
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      const total = lines.length;
      let start = a.start_line ?? 1;
      let end = Math.min(a.end_line ?? total, total);
      if (start > Math.max(total, 1)) throw new HAError(`start_line ${start} is past the end of the file (${total} lines)`);
      let content = lines.slice(start - 1, end).join("\n");
      let truncated = false;
      if (content.length > READ_CHUNK_CHARS) {
        // cut at a line boundary
        const cut = content.lastIndexOf("\n", READ_CHUNK_CHARS);
        content = content.slice(0, cut > 0 ? cut : READ_CHUNK_CHARS);
        end = start + content.split("\n").length - 1;
        truncated = true;
      }
      return {
        ...meta,
        total_lines: total,
        ...(start !== 1 || end !== total ? { start_line: start, end_line: end } : {}),
        ...(truncated ? { truncated: true, next_start_line: end + 1 } : {}),
        ...(check ? { check } : {}),
        content,
      };
    },
  );

  // ------------------------------------------------------------------ write

  defineTool(
    ctx,
    "ha_write_config_file",
    {
      title: "Create or overwrite a config file",
      description:
        "Create a new file or replace a file's whole content in the Home Assistant config directory. " +
        "Prefer ha_edit_config_file for changes to existing files. YAML/JSON is validated first (HA tags like !include, !secret, " +
        "!include_dir_named, !env_var, !input are understood) and invalid content is refused unless force=true. " +
        "The previous version is backed up (ha_list_config_backups / ha_restore_config_backup), the write is atomic, and a unified diff is returned. " +
        `Allowed types: ${WRITABLE_EXTENSIONS.join(", ")} and .py in python_scripts/. Not allowed: .storage/, secrets.yaml (use ha_set_secret), databases, logs. ` +
        "Missing parent folders are created. Nothing is reloaded: call ha_check_config and ha_reload_config afterwards.",
      inputSchema: {
        path: z.string().describe("File path relative to the config dir, e.g. 'packages/garden.yaml'"),
        content: z.string().describe("The complete new file content"),
        create_only: z.boolean().default(false).describe("Fail if the file already exists"),
        expected_sha256: z.string().optional().describe("sha256 from ha_read_config_file; refuse if the file changed since"),
        force: z.boolean().default(false).describe("Write even if the YAML/JSON does not validate"),
        dry_run: z.boolean().default(false).describe("Only validate and show the diff, do not write"),
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      const r = await sandbox.resolve(a.path);
      sandbox.assertWritable(r);
      if (r.exists && a.create_only) throw new HAError(`${r.rel} already exists (create_only)`);
      return commit(r, a.content, { force: a.force, expectedSha: a.expected_sha256, dryRun: a.dry_run });
    },
  );

  // ------------------------------------------------------------------ edit

  const pathSchema = z
    .union([z.string(), z.array(z.union([z.string(), z.number().int().min(0)])).min(1)])
    .describe(
      "YAML path. String form: dots between keys, [n] for list items, quoted brackets for keys containing dots, " +
        `e.g. 'homeassistant.customize["light.kitchen"].friendly_name' or 'automation[0].alias'. Or an array: ["homeassistant","customize","light.kitchen"]`,
    );

  defineTool(
    ctx,
    "ha_edit_config_file",
    {
      title: "Edit a config file",
      description:
        "Make targeted changes to an existing file in the Home Assistant config directory, keeping comments and formatting. Two kinds of edit, applied in order (all or nothing):\n" +
        "1. replacements: exact text replace, like a code editor. old_string must match exactly once (including indentation) unless replace_all.\n" +
        "2. yaml_operations (YAML files only): set or delete a value by YAML path, e.g. {path: 'homeassistant.customize[\"light.kitchen\"].friendly_name', action: 'set', value: 'Kitchen'}. " +
        "Missing parent keys are created. Use value (JSON) for plain data or value_yaml for YAML with HA tags (e.g. '!secret wifi_password', '!include_dir_named packages').\n" +
        "The result is validated before writing (refused if invalid, unless force), the old version is backed up, and a diff is returned. Use dry_run to preview. " +
        "Not for secrets.yaml (use ha_set_secret) or .storage/.",
      inputSchema: {
        path: z.string().describe("File path relative to the config dir"),
        replacements: z
          .array(
            z.object({
              old_string: z.string().min(1).describe("Exact text to find"),
              new_string: z.string().describe("Replacement text"),
              replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring exactly one"),
            }),
          )
          .optional(),
        yaml_operations: z
          .array(
            z.object({
              path: pathSchema,
              action: z.enum(["set", "delete"]).default("set"),
              value: z.any().optional().describe("New value as JSON (string, number, bool, list, object)"),
              value_yaml: z.string().optional().describe("New value as YAML text, e.g. '!secret api_key' or a block"),
            }),
          )
          .optional(),
        expected_sha256: z.string().optional().describe("sha256 from ha_read_config_file; refuse if the file changed since"),
        force: z.boolean().default(false).describe("Write even if the result does not validate"),
        dry_run: z.boolean().default(false).describe("Only show the diff, do not write"),
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      const reps = (a.replacements ?? []) as { old_string: string; new_string: string; replace_all: boolean }[];
      const ops = (a.yaml_operations ?? []) as YamlOp[];
      if (reps.length === 0 && ops.length === 0) throw new HAError("Nothing to do: give replacements and/or yaml_operations");
      const r = await sandbox.resolve(a.path);
      sandbox.assertWritable(r);
      if (!r.exists) throw new HAError(`File not found: ${r.rel} (use ha_write_config_file to create it)`);
      if (ops.length && !isYaml(r.rel)) throw new HAError("yaml_operations only work on .yaml/.yml files");
      const oldBuf = await readExisting(r);
      let text = oldBuf!.toString("utf8");
      const replaced: number[] = [];
      reps.forEach((rep, i) => {
        try {
          const out = strReplace(text, rep.old_string, rep.new_string, rep.replace_all);
          text = out.text;
          replaced.push(out.count);
        } catch (e) {
          const hint = (rep.old_string + rep.new_string).includes(REDACTED)
            ? ` Note: "${REDACTED}" is only a display placeholder; the file contains the real value. ${REDACTION_NOTE}`
            : "";
          throw new HAError(`replacements[${i}]: ${(e as Error).message}${hint}`);
        }
      });
      if (ops.length) text = applyYamlOps(text, ops);
      const res = await commit(r, text, { force: a.force, expectedSha: a.expected_sha256, dryRun: a.dry_run, oldBuf });
      return reps.length ? { ...res, replacements_applied: replaced } : res;
    },
  );

  // ------------------------------------------------------------------ delete

  defineTool(
    ctx,
    "ha_delete_config_file",
    {
      title: "Delete a config file (to backup)",
      description:
        "Remove a file from the Home Assistant config directory. The file is not destroyed: it is moved to the backup folder and can be " +
        "brought back with ha_restore_config_backup. configuration.yaml and secrets.yaml cannot be deleted. " +
        "Check that nothing still !include's the file, then run ha_check_config.",
      inputSchema: {
        path: z.string().describe("File path relative to the config dir"),
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      const r = await sandbox.resolve(a.path);
      if (r.rel === "configuration.yaml") throw new HAError("Refusing to delete configuration.yaml");
      sandbox.assertWritable(r);
      if (!r.exists) throw new HAError(`File not found: ${r.rel}`);
      const id = await (await backups()).moveIn(r.rel, r.abs);
      return { path: r.rel, deleted: true, backup_id: id, note: "Moved to backups; restore with ha_restore_config_backup." };
    },
  );

  // ------------------------------------------------------------------ backups

  defineTool(
    ctx,
    "ha_list_config_backups",
    {
      title: "List backups of a config file",
      description:
        `List the saved previous versions of a config file (newest first; the last ${MAX_BACKUPS} are kept). ` +
        "A version is saved before every write/edit/restore, and deleted files are kept here too (reason: deleted). " +
        "Use the id with ha_restore_config_backup.",
      inputSchema: {
        path: z.string().describe("File path relative to the config dir (the file may no longer exist)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      const r = await sandbox.resolve(a.path);
      const list = await (await backups()).list(r.rel);
      return { path: r.rel, exists: r.exists, backups: list.map(({ file: _f, ...b }) => b) };
    },
  );

  defineTool(
    ctx,
    "ha_restore_config_backup",
    {
      title: "Restore a config file from backup",
      description:
        "Put a saved version of a config file back (undo a write, edit or delete). Defaults to the newest backup. " +
        "The current version (if any) is backed up first, so a restore can itself be undone. Returns a diff (not for secrets.yaml). " +
        "Then run ha_check_config and ha_reload_config.",
      inputSchema: {
        path: z.string().describe("File path relative to the config dir"),
        backup_id: z.string().optional().describe("Backup id from ha_list_config_backups (default: newest)"),
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      const r = await sandbox.resolve(a.path);
      sandbox.assertWritable(r, { allowSecrets: true });
      const { info, content } = await (await backups()).read(r.rel, a.backup_id);
      if (looksBinary(content)) throw new HAError("Backup looks binary; refusing to restore");
      const res = await commit(r, content.toString("utf8"), { force: true, secret: isSecretsFile(r.rel) });
      return { ...res, restored_from: info };
    },
  );

  // ------------------------------------------------------------------ check & reload

  async function checkConfig() {
    const res = await ha.post<{ result?: string; errors?: unknown; warnings?: unknown }>(
      "/api/config/core/check_config",
      {},
      "config",
    );
    return {
      result: res?.result ?? "unknown",
      valid: res?.result === "valid",
      errors: res?.errors ?? null,
      ...(res?.warnings ? { warnings: res.warnings } : {}),
    };
  }

  defineTool(
    ctx,
    "ha_check_config",
    {
      title: "Check Home Assistant configuration",
      description:
        "Ask Home Assistant to validate the whole YAML configuration on disk (like Developer tools > Check configuration). " +
        "Returns result 'valid' or 'invalid' with error text. Run this after changing config files and before reloading or restarting. " +
        "It does not change anything.",
      inputSchema: {},
      // It is a POST, but it only validates; nothing changes.
      annotations: READ_ONLY,
    },
    async () => checkConfig(),
  );

  defineTool(
    ctx,
    "ha_reload_config",
    {
      title: "Reload YAML configuration",
      description:
        "Apply changed YAML without restarting Home Assistant by reloading one part: " +
        "automation, script, scene, group, template, input_* helpers, timer, counter, schedule, zone, person, " +
        "core (homeassistant: section incl. customize), custom_templates (custom_templates/*.jinja), python_script, " +
        "command_line, rest, mqtt, or all (every reloadable YAML integration). " +
        "Runs ha_check_config first and aborts if the config is invalid (check_first=false to skip). " +
        "Some integrations cannot be reloaded and need a restart.",
      inputSchema: {
        target: z.enum(RELOAD_KEYS).describe("What to reload"),
        check_first: z.boolean().default(true).describe("Validate the configuration first and abort if invalid"),
      },
      annotations: WRITE,
    },
    async (a) => {
      let check: Awaited<ReturnType<typeof checkConfig>> | undefined;
      if (a.check_first) {
        check = await checkConfig();
        if (!check.valid) {
          throw new HAError(`Configuration is invalid; not reloading. Errors: ${String(check.errors ?? "unknown").slice(0, 2000)}`);
        }
      }
      const [domain, service] = RELOADS[a.target];
      await ha.callService(domain, service, {}, "config");
      return { reloaded: `${domain}.${service}`, ...(check ? { check } : {}) };
    },
  );

  // ------------------------------------------------------------------ secrets

  const secretsFileSchema = z
    .string()
    .default("secrets.yaml")
    .describe("Which secrets.yaml (default: the one in the config dir root). Must be named secrets.yaml");

  async function resolveSecretsFile(file: string) {
    const r = await sandbox.resolve(file);
    if (!isSecretsFile(r.rel)) throw new HAError("The file must be named secrets.yaml");
    sandbox.assertWritable(r, { allowSecrets: true });
    return r;
  }

  defineTool(
    ctx,
    "ha_list_secrets",
    {
      title: "List secret names",
      description:
        "List the NAMES defined in secrets.yaml files (values are never shown), plus !secret references in YAML files that " +
        "are not defined anywhere, and names that are defined but not referenced.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const root = await sandbox.root();
      const all = await listFiles(root, root, { maxDepth: 10, matchBasename: true, includeSystem: false, allText: false, limit: 2000 });
      const files: Record<string, string[]> = {};
      const referenced = new Map<string, Set<string>>();
      for (const f of all.files) {
        if (f.size > MAX_READ_BYTES) continue;
        const text = await fs.readFile(path.join(root, f.path), "utf8").catch(() => null);
        if (text === null) continue;
        if (isSecretsFile(f.path)) {
          files[f.path] = secretNames(text);
          continue;
        }
        for (const m of text.matchAll(/!secret\s+([^\s#,\]}]+)/g)) {
          const set = referenced.get(m[1]) ?? new Set<string>();
          set.add(f.path);
          referenced.set(m[1], set);
        }
      }
      const defined = new Set(Object.values(files).flat());
      return {
        secrets_files: files,
        undefined_references: [...referenced].filter(([n]) => !defined.has(n)).map(([name, where]) => ({ name, used_in: [...where] })),
        unused: [...defined].filter((n) => !referenced.has(n)),
      };
    },
  );

  defineTool(
    ctx,
    "ha_set_secret",
    {
      title: "Add or update a secret",
      description:
        "Add or change a value in secrets.yaml, to be used in YAML as '!secret <name>'. The value is stored as a quoted string " +
        "and is never echoed back, logged or shown in a diff. The previous secrets.yaml is backed up. " +
        "Afterwards reference it with ha_edit_config_file (value_yaml: '!secret <name>') and reload the integration that uses it.",
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "letters, digits, _ . -").max(200).describe("Secret name, e.g. 'mqtt_password'"),
        secret_value: z.string().max(65536).describe("The secret value (never returned or logged)"),
        file: secretsFileSchema,
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      const r = await resolveSecretsFile(a.file);
      const oldBuf = await readExisting(r);
      const out = setSecret(oldBuf?.toString("utf8") ?? "", a.name, a.secret_value);
      const res: any = await commit(r, out.text, { secret: true, oldBuf });
      return { path: r.rel, name: a.name, action: res.changed === false ? "unchanged" : out.existed ? "updated" : "added", backup_id: res.backup_id, usage: `!secret ${a.name}` };
    },
  );

  defineTool(
    ctx,
    "ha_delete_secret",
    {
      title: "Delete a secret",
      description:
        "Remove a name from secrets.yaml (the previous file is backed up). Check with ha_list_secrets that it is no longer referenced, " +
        "otherwise Home Assistant will fail to load the YAML that uses it.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Secret name"),
        file: secretsFileSchema,
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      const r = await resolveSecretsFile(a.file);
      const oldBuf = await readExisting(r);
      if (!oldBuf) throw new HAError(`${r.rel} does not exist`);
      const out = deleteSecret(oldBuf.toString("utf8"), a.name);
      if (!out.existed) throw new HAError(`Secret '${a.name}' is not defined in ${r.rel}`);
      const res: any = await commit(r, out.text, { secret: true, oldBuf });
      return { path: r.rel, name: a.name, action: "deleted", backup_id: res.backup_id };
    },
  );
}
