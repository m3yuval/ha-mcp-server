// Config file tools: sandbox, validation, backups, secrets, check/reload.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startFakeHA, startMcp, reply } from "./helpers/harness.mjs";

const CONFIG_TOOLS = [
  "ha_check_config", "ha_delete_config_file", "ha_delete_secret", "ha_edit_config_file", "ha_list_config_backups",
  "ha_list_config_files", "ha_list_secrets", "ha_read_config_file", "ha_reload_config", "ha_restore_config_backup",
  "ha_set_secret", "ha_write_config_file",
];

const CONFIGURATION = `# Main configuration
homeassistant:
  name: Test Home # shown in the UI
  customize: !include customize.yaml
  packages: !include_dir_named packages

# Web server
http:
  api_password: !secret http_password

automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
`;

const AUTOMATIONS = `- id: '1700000000001'
  alias: Morning lights
  trigger:
  - platform: time
    at: 07:00:00
  action:
  - service: light.turn_on
    target:
      entity_id: light.kitchen
`;

const SECRET_1 = "supersecret123";
const SECRET_2 = "hunter2-wifi";
const STORAGE_TOKEN = "tok-abc-123-storage";

let tmp, outside, fake, srv, checkResult;

async function populate(dir) {
  const w = async (rel, content) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  };
  await w("configuration.yaml", CONFIGURATION);
  await w("customize.yaml", "# customizations\nlight.kitchen:\n  friendly_name: Kitchen # nice name\n");
  await w("automations.yaml", AUTOMATIONS);
  await w("scripts.yaml", "hello:\n  sequence: []\n");
  await w("scenes.yaml", "[]\n");
  await w("secrets.yaml", `# secrets\nhttp_password: "${SECRET_1}"\nwifi_key: ${SECRET_2}\n`);
  await w("packages/garden.yaml", "input_boolean:\n  garden_watering:\n    name: Garden watering\n");
  await w("packages/secrets.yaml", `pkg_token: nested-${SECRET_1}\n`);
  await w("deps/lib.yaml", "x: 1\n");
  await w(".storage/core.config_entries", JSON.stringify({ version: 1, data: { entries: [{ domain: "demo", data: { access_token: STORAGE_TOKEN, host: "1.2.3.4" } }] } }));
  await w(".storage/auth", JSON.stringify({ data: { refresh_tokens: [] } }));
  await w("home-assistant_v2.db", Buffer.from([0, 1, 2, 3, 0, 255]));
  await w("notes.txt", "hello\n");
  // symlinks escaping the config dir
  await fs.writeFile(path.join(outside, "outside.yaml"), "stolen: true\n");
  await fs.symlink(path.join(outside, "outside.yaml"), path.join(dir, "escape.yaml"));
  await fs.symlink(outside, path.join(dir, "escape_dir"));
  // symlink inside the config dir (allowed)
  await fs.symlink(path.join(dir, "customize.yaml"), path.join(dir, "customize_link.yaml"));
}

const read = (rel) => fs.readFile(path.join(tmp, rel), "utf8");
const backupFiles = async (relDir = "") => {
  try {
    return (await fs.readdir(path.join(tmp, ".ha-mcp-backups", relDir))).sort();
  } catch {
    return [];
  }
};

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ha-mcp-cfg-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "ha-mcp-outside-"));
  await populate(tmp);
  checkResult = { result: "valid", errors: null };
  fake = await startFakeHA({
    rest: {
      "POST /api/config/core/check_config": () => checkResult,
      "POST /api/services/*": () => [],
    },
  });
  srv = await startMcp({ fake, env: { ENABLE_CONFIG_FILES: "true", CONFIG_DIR: tmp } });
});

after(async () => {
  await srv?.stop();
  await fake?.stop();
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

// ------------------------------------------------------------------ gating

test("registration gating: needs ENABLE_CONFIG_FILES and CONFIG_DIR", async () => {
  const noFlag = await startMcp({ fake, env: { CONFIG_DIR: tmp } });
  try {
    const names = await noFlag.toolNames();
    for (const t of CONFIG_TOOLS) assert.ok(!names.includes(t), `${t} registered without ENABLE_CONFIG_FILES`);
  } finally {
    await noFlag.stop();
  }
  const noDir = await startMcp({ fake, env: { ENABLE_CONFIG_FILES: "true" } });
  try {
    const names = await noDir.toolNames();
    for (const t of CONFIG_TOOLS) assert.ok(!names.includes(t), `${t} registered without CONFIG_DIR`);
  } finally {
    await noDir.stop();
  }
  const tools = await srv.tools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const t of CONFIG_TOOLS) assert.ok(byName[t], `${t} missing`);
  for (const t of ["ha_list_config_files", "ha_read_config_file", "ha_list_config_backups", "ha_check_config", "ha_list_secrets"]) {
    assert.equal(byName[t].annotations.readOnlyHint, true, t);
  }
  for (const t of ["ha_write_config_file", "ha_edit_config_file", "ha_delete_config_file", "ha_restore_config_backup", "ha_set_secret", "ha_delete_secret"]) {
    assert.equal(byName[t].annotations.destructiveHint, true, t);
  }
  assert.equal(byName.ha_reload_config.annotations.readOnlyHint, false);
  assert.equal(byName.ha_reload_config.annotations.destructiveHint, false);
});

// ------------------------------------------------------------------ list / read

test("list: YAML files, skips system dirs, databases and escaping symlinks", async () => {
  const r = await srv.call("ha_list_config_files");
  assert.ok(!r.isError, r.text);
  const paths = r.json.files.map((f) => f.path);
  for (const p of ["configuration.yaml", "automations.yaml", "secrets.yaml", "packages/garden.yaml", "customize_link.yaml"]) {
    assert.ok(paths.includes(p), `missing ${p}`);
  }
  for (const p of ["deps/lib.yaml", "escape.yaml", "notes.txt"]) assert.ok(!paths.includes(p), `unexpected ${p}`);
  assert.ok(!paths.some((p) => p.startsWith(".storage") || p.includes(".db") || p.startsWith("escape_dir")));
  assert.ok(r.json.skipped_dirs.includes("deps/"));
  assert.ok(r.json.well_known["automations.yaml"]);
  const f = r.json.files.find((x) => x.path === "configuration.yaml");
  assert.equal(f.size, Buffer.byteLength(CONFIGURATION));
  assert.match(f.modified, /^\d{4}-\d\d-\d\dT/);

  const g = await srv.call("ha_list_config_files", { pattern: "packages/**/*.yaml" });
  assert.deepEqual(g.json.files.map((x) => x.path), ["packages/garden.yaml", "packages/secrets.yaml"]);
  const t = await srv.call("ha_list_config_files", { include_all_text: true, pattern: "*.txt" });
  assert.deepEqual(t.json.files.map((x) => x.path), ["notes.txt"]);
});

test("read: content, YAML check with HA tags, line range, sha256", async () => {
  const r = await srv.call("ha_read_config_file", { path: "configuration.yaml" });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.content, CONFIGURATION.replace(/\n$/, ""));
  assert.equal(r.json.check.valid, true);
  assert.deepEqual(r.json.check.warnings, []);
  assert.match(r.json.sha256, /^[0-9a-f]{64}$/);

  const part = await srv.call("ha_read_config_file", { path: "configuration.yaml", start_line: 2, end_line: 3 });
  assert.equal(part.json.content, "homeassistant:\n  name: Test Home # shown in the UI");
  assert.equal(part.json.start_line, 2);

  // /config/... spelling maps to the config dir
  const alt = await srv.call("ha_read_config_file", { path: "/config/customize.yaml" });
  assert.ok(!alt.isError, alt.text);
  assert.match(alt.json.content, /friendly_name: Kitchen/);
});

test("read: reports YAML errors with line numbers and missing include/secret", async () => {
  await fs.writeFile(path.join(tmp, "broken.yaml"), "a: 1\nb: [\n");
  const r = await srv.call("ha_read_config_file", { path: "broken.yaml" });
  assert.equal(r.json.check.valid, false);
  assert.ok(r.json.check.errors[0].line >= 1);
  await fs.writeFile(path.join(tmp, "refs.yaml"), "x: !include nope.yaml\ny: !secret not_defined\n");
  const w = await srv.call("ha_read_config_file", { path: "refs.yaml" });
  const msgs = w.json.check.warnings.map((x) => x.message).join("\n");
  assert.match(msgs, /nope\.yaml.*does not exist/);
  assert.match(msgs, /not_defined/);
  await fs.rm(path.join(tmp, "broken.yaml"));
  await fs.rm(path.join(tmp, "refs.yaml"));
});

test("secrets.yaml values are never returned (root and nested)", async () => {
  const r = await srv.call("ha_read_config_file", { path: "secrets.yaml" });
  assert.ok(!r.isError, r.text);
  assert.ok(!r.text.includes(SECRET_1) && !r.text.includes(SECRET_2), r.text);
  assert.match(r.json.content, /http_password: "\*\*\*"\nwifi_key: "\*\*\*"/);
  assert.match(r.json.content, /# secrets/);
  assert.deepEqual(r.json.secret_names, ["http_password", "wifi_key"]);
  assert.equal(r.json.sha256, undefined);
  const n = await srv.call("ha_read_config_file", { path: "packages/secrets.yaml" });
  assert.ok(!n.text.includes(SECRET_1), n.text);
  const range = await srv.call("ha_read_config_file", { path: "secrets.yaml", start_line: 2, end_line: 2 });
  assert.ok(!range.text.includes(SECRET_1));

  const l = await srv.call("ha_list_secrets");
  assert.deepEqual(l.json.secrets_files["secrets.yaml"], ["http_password", "wifi_key"]);
  assert.ok(l.json.unused.includes("wifi_key"));
  assert.ok(!l.text.includes(SECRET_1) && !l.text.includes(SECRET_2));
});

test(".storage: readable with redaction, auth refused, never writable", async () => {
  const r = await srv.call("ha_read_config_file", { path: ".storage/core.config_entries" });
  assert.ok(!r.isError, r.text);
  assert.ok(!r.text.includes(STORAGE_TOKEN));
  assert.match(r.json.content, /"access_token": "\*\*\*"/);
  assert.match(r.json.content, /"host": "1\.2\.3\.4"/);
  assert.equal(r.json.read_only, true);
  const a = await srv.call("ha_read_config_file", { path: ".storage/auth" });
  assert.ok(a.isError);
  const w = await srv.call("ha_write_config_file", { path: ".storage/core.config_entries", content: "{}" });
  assert.ok(w.isError);
  assert.match(w.text, /\.storage/);
  const w2 = await srv.call("ha_write_config_file", { path: ".storage/new.json", content: "{}" });
  assert.ok(w2.isError);
});

// ------------------------------------------------------------------ sandbox

test("sandbox: traversal, absolute paths, escaping symlinks, forbidden files", async () => {
  const bad = [
    ["ha_read_config_file", { path: "../outside.yaml" }, /escapes/],
    ["ha_read_config_file", { path: path.join(outside, "outside.yaml") }, /outside/],
    ["ha_read_config_file", { path: "/etc/passwd" }, /outside/],
    ["ha_read_config_file", { path: "escape.yaml" }, /symlink/],
    ["ha_read_config_file", { path: "escape_dir/outside.yaml" }, /symlink/],
    ["ha_read_config_file", { path: "home-assistant_v2.db" }, /database/],
    ["ha_read_config_file", { path: "packages/../../x.yaml" }, /escapes/],
    ["ha_write_config_file", { path: "../evil.yaml", content: "a: 1\n" }, /escapes/],
    ["ha_write_config_file", { path: "escape.yaml", content: "a: 1\n" }, /symlink/],
    ["ha_write_config_file", { path: "escape_dir/new.yaml", content: "a: 1\n" }, /symlink/],
    ["ha_write_config_file", { path: "home-assistant_v2.db", content: "x" }, /database/],
    ["ha_write_config_file", { path: ".ha-mcp-backups/x.yaml", content: "a: 1\n" }, /restore/],
    ["ha_write_config_file", { path: "run.sh", content: "echo hi" }, /allowed file types/],
    ["ha_write_config_file", { path: "evil.py", content: "print(1)" }, /allowed file types/],
    ["ha_write_config_file", { path: "secrets.yaml", content: "a: b\n" }, /ha_set_secret/],
    ["ha_edit_config_file", { path: "secrets.yaml", replacements: [{ old_string: "wifi_key", new_string: "x" }] }, /ha_set_secret/],
    ["ha_delete_config_file", { path: "secrets.yaml" }, /ha_set_secret/],
    ["ha_delete_config_file", { path: "configuration.yaml" }, /configuration\.yaml/],
    ["ha_delete_config_file", { path: "escape.yaml" }, /symlink/],
  ];
  for (const [tool, args, re] of bad) {
    const r = await srv.call(tool, args);
    assert.ok(r.isError, `${tool} ${JSON.stringify(args)} should fail: ${r.text}`);
    assert.match(r.text, re, `${tool} ${JSON.stringify(args)}`);
  }
  assert.equal(await fs.readFile(path.join(outside, "outside.yaml"), "utf8"), "stolen: true\n");
  await assert.rejects(fs.stat(path.join(outside, "new.yaml")));
  await assert.rejects(fs.stat(path.join(path.dirname(tmp), "evil.yaml")));
  assert.match(await read("secrets.yaml"), new RegExp(SECRET_2));
  // python_scripts/*.py is allowed
  const py = await srv.call("ha_write_config_file", { path: "python_scripts/hello.py", content: "logger.info('hi')\n" });
  assert.ok(!py.isError, py.text);
  assert.equal(fake.writes().length, 0, "file tools must not call Home Assistant");
});

// ------------------------------------------------------------------ write / edit

test("write: create, overwrite with backup + diff, create_only, dry_run, expected_sha256", async () => {
  const c = await srv.call("ha_write_config_file", { path: "packages/new/pool.yaml", content: "input_boolean:\n  pool_pump:\n    name: Pool pump\n" });
  assert.ok(!c.isError, c.text);
  assert.equal(c.json.action, "created");
  assert.equal(c.json.backup_id, undefined);
  assert.match(await read("packages/new/pool.yaml"), /pool_pump/);

  const again = await srv.call("ha_write_config_file", { path: "packages/new/pool.yaml", content: "x: 1\n", create_only: true });
  assert.ok(again.isError);

  const rd = await srv.call("ha_read_config_file", { path: "packages/new/pool.yaml" });
  const dry = await srv.call("ha_write_config_file", { path: "packages/new/pool.yaml", content: "input_boolean:\n  pool_pump:\n    name: Pool\n", dry_run: true });
  assert.equal(dry.json.dry_run, true);
  assert.match(dry.json.diff, /-    name: Pool pump\n\+    name: Pool/);
  assert.match(await read("packages/new/pool.yaml"), /Pool pump/);

  const o = await srv.call("ha_write_config_file", {
    path: "packages/new/pool.yaml",
    content: "input_boolean:\n  pool_pump:\n    name: Pool\n",
    expected_sha256: rd.json.sha256,
  });
  assert.ok(!o.isError, o.text);
  assert.equal(o.json.action, "updated");
  assert.match(o.json.backup_id, /^\d{8}T\d{9}Z/);
  assert.match(o.json.diff, /^--- a\/packages\/new\/pool\.yaml\n\+\+\+ b\/packages\/new\/pool\.yaml\n@@ -1,3 \+1,3 @@/);
  assert.deepEqual(o.json.diff_stats, { added: 1, removed: 1 });
  const bak = await backupFiles("packages/new");
  assert.equal(bak.length, 1);
  assert.equal(await fs.readFile(path.join(tmp, ".ha-mcp-backups/packages/new", bak[0]), "utf8"), "input_boolean:\n  pool_pump:\n    name: Pool pump\n");
  assert.ok(!(await fs.readdir(path.join(tmp, "packages/new"))).some((f) => f.includes("tmp")), "temp file left behind");

  const stale = await srv.call("ha_write_config_file", { path: "packages/new/pool.yaml", content: "a: 1\n", expected_sha256: rd.json.sha256 });
  assert.ok(stale.isError);
  assert.match(stale.text, /changed since/);
});

test("write: invalid YAML refused (file untouched) unless force; HA tags accepted", async () => {
  const before = await read("customize.yaml");
  const r = await srv.call("ha_write_config_file", { path: "customize.yaml", content: "light.kitchen:\n  friendly_name: [oops\n" });
  assert.ok(r.isError);
  assert.match(r.text, /invalid YAML.*line/);
  assert.equal(await read("customize.yaml"), before);
  const dup = await srv.call("ha_write_config_file", { path: "dup.yaml", content: "a: 1\na: 2\n" });
  assert.ok(dup.isError);
  const tags = await srv.call("ha_write_config_file", {
    path: "tags.yaml",
    content: "a: !include customize.yaml\nb: !include_dir_merge_named packages\nc: !include_dir_list packages\nd: !include_dir_merge_list packages\ne: !secret wifi_key\nf: !env_var HOME\ng: !input my_input\n",
  });
  assert.ok(!tags.isError, tags.text);
  assert.equal(tags.json.valid, true);
  const badJson = await srv.call("ha_write_config_file", { path: "x.json", content: "{nope" });
  assert.ok(badJson.isError);
  const forced = await srv.call("ha_write_config_file", { path: "forced.yaml", content: "a: [\n", force: true });
  assert.ok(!forced.isError, forced.text);
  assert.equal(forced.json.forced, true);
  assert.equal(await read("forced.yaml"), "a: [\n");
  await fs.rm(path.join(tmp, "forced.yaml"));
  await fs.rm(path.join(tmp, "tags.yaml"));
});

test("edit: str_replace needs exactly one match (0 / 1 / 2 / replace_all)", async () => {
  await fs.writeFile(path.join(tmp, "multi.yaml"), "a:\n  name: x\nb:\n  name: x\nc:\n  name: y\n");
  const none = await srv.call("ha_edit_config_file", { path: "multi.yaml", replacements: [{ old_string: "name: z", new_string: "name: q" }] });
  assert.ok(none.isError);
  assert.match(none.text, /not found/);
  const two = await srv.call("ha_edit_config_file", { path: "multi.yaml", replacements: [{ old_string: "name: x", new_string: "name: q" }] });
  assert.ok(two.isError);
  assert.match(two.text, /matches 2 times \(lines 2, 4\)/);
  assert.equal(await read("multi.yaml"), "a:\n  name: x\nb:\n  name: x\nc:\n  name: y\n");
  const one = await srv.call("ha_edit_config_file", { path: "multi.yaml", replacements: [{ old_string: "name: y", new_string: "name: why" }] });
  assert.ok(!one.isError, one.text);
  assert.deepEqual(one.json.replacements_applied, [1]);
  assert.match(one.json.diff, /-  name: y\n\+  name: why/);
  const all = await srv.call("ha_edit_config_file", { path: "multi.yaml", replacements: [{ old_string: "name: x", new_string: "name: q", replace_all: true }] });
  assert.ok(!all.isError, all.text);
  assert.equal(await read("multi.yaml"), "a:\n  name: q\nb:\n  name: q\nc:\n  name: why\n");
  // an edit that would make the YAML invalid is refused
  const breaks = await srv.call("ha_edit_config_file", { path: "multi.yaml", replacements: [{ old_string: "name: why", new_string: "name: [why" }] });
  assert.ok(breaks.isError);
  assert.match(await read("multi.yaml"), /name: why/);
  await fs.rm(path.join(tmp, "multi.yaml"));
});

test("edit: YAML-path set/delete keeps comments, tags and HA list style", async () => {
  const r = await srv.call("ha_edit_config_file", {
    path: "configuration.yaml",
    yaml_operations: [
      { path: "http.server_port", value: 8124 },
      { path: ["homeassistant", "customize_glob"], value: { "light.*": { icon: "mdi:lightbulb" } } },
      { path: "mqtt.password", value_yaml: "!secret wifi_key" },
    ],
  });
  assert.ok(!r.isError, r.text);
  const text = await read("configuration.yaml");
  assert.match(text, /^# Main configuration\n/);
  assert.match(text, /name: Test Home # shown in the UI/);
  assert.match(text, /# Web server\nhttp:\n  api_password: !secret http_password\n  server_port: 8124/);
  assert.match(text, /packages: !include_dir_named packages/);
  assert.match(text, /customize_glob:\n    light\.\*:\n      icon: mdi:lightbulb/);
  assert.match(text, /mqtt:\n  password: !secret wifi_key/);
  assert.equal(r.json.valid, true);

  // keys with dots, bracket syntax; comments in customize.yaml preserved
  const c = await srv.call("ha_edit_config_file", {
    path: "customize.yaml",
    yaml_operations: [{ path: 'light.kitchen', value: "x" }, { path: '["light.kitchen"].icon', value: "mdi:ceiling-light" }],
  });
  // 'light.kitchen' (unquoted) means light > kitchen: creates a new 'light' key. Then the quoted form edits the entity.
  assert.ok(!c.isError, c.text);
  const cust = await read("customize.yaml");
  assert.match(cust, /# customizations\nlight\.kitchen:\n  friendly_name: Kitchen # nice name\n  icon: mdi:ceiling-light\nlight:\n  kitchen: x\n/);
  const d = await srv.call("ha_edit_config_file", { path: "customize.yaml", yaml_operations: [{ path: "light", action: "delete" }] });
  assert.ok(!d.isError, d.text);
  assert.ok(!(await read("customize.yaml")).includes("kitchen: x"));
  const missing = await srv.call("ha_edit_config_file", { path: "customize.yaml", yaml_operations: [{ path: "nope.x", action: "delete" }] });
  assert.ok(missing.isError);
  assert.match(missing.text, /not found/);

  // HA-written list style (unindented sequences) is kept
  const a = await srv.call("ha_edit_config_file", { path: "automations.yaml", yaml_operations: [{ path: "[0].alias", value: "Wake up lights" }] });
  assert.ok(!a.isError, a.text);
  assert.equal(await read("automations.yaml"), AUTOMATIONS.replace("Morning lights", "Wake up lights"));
  assert.deepEqual(a.json.diff_stats, { added: 1, removed: 1 });
  assert.match(a.json.next_step, /automation/);
});

// ------------------------------------------------------------------ delete / backups / restore

test("delete moves to backup; list backups; restore brings it back", async () => {
  await fs.writeFile(path.join(tmp, "packages/old.yaml"), "input_boolean:\n  old: {}\n");
  const d = await srv.call("ha_delete_config_file", { path: "packages/old.yaml" });
  assert.ok(!d.isError, d.text);
  await assert.rejects(fs.stat(path.join(tmp, "packages/old.yaml")));
  const l = await srv.call("ha_list_config_backups", { path: "packages/old.yaml" });
  assert.equal(l.json.exists, false);
  assert.equal(l.json.backups.length, 1);
  assert.equal(l.json.backups[0].reason, "deleted");
  assert.equal(l.json.backups[0].id, d.json.backup_id);
  const r = await srv.call("ha_restore_config_backup", { path: "packages/old.yaml" });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.action, "created");
  assert.equal(await read("packages/old.yaml"), "input_boolean:\n  old: {}\n");

  // restore after an edit: current version is backed up first, so restore is undoable
  await srv.call("ha_write_config_file", { path: "packages/old.yaml", content: "input_boolean:\n  newer: {}\n" });
  const list = await srv.call("ha_list_config_backups", { path: "packages/old.yaml" });
  const r2 = await srv.call("ha_restore_config_backup", { path: "packages/old.yaml", backup_id: list.json.backups[0].id });
  assert.ok(!r2.isError, r2.text);
  assert.equal(await read("packages/old.yaml"), "input_boolean:\n  old: {}\n");
  assert.match(r2.json.diff, /-  newer: \{\}\n\+  old: \{\}/);
  const bad = await srv.call("ha_restore_config_backup", { path: "packages/old.yaml", backup_id: "20000101T000000000Z" });
  assert.ok(bad.isError);
  // backups are not readable through the read tool
  const rb = await srv.call("ha_read_config_file", { path: `.ha-mcp-backups/packages/old.yaml.${d.json.backup_id}.deleted.bak` });
  assert.ok(rb.isError);
  // and not listed
  const all = await srv.call("ha_list_config_files", { include_system: true, include_all_text: true });
  assert.ok(!all.json.files.some((f) => f.path.startsWith(".ha-mcp-backups")));
});

test("backups are rotated: at most 20 per file", async () => {
  for (let i = 0; i < 25; i++) {
    const r = await srv.call("ha_write_config_file", { path: "rotate.yaml", content: `n: ${i}\n` });
    assert.ok(!r.isError, r.text);
  }
  const files = (await backupFiles()).filter((f) => f.startsWith("rotate.yaml."));
  assert.equal(files.length, 20);
  const l = await srv.call("ha_list_config_backups", { path: "rotate.yaml" });
  assert.equal(l.json.backups.length, 20);
  // newest first: the newest backup holds the second-to-last write
  const r = await srv.call("ha_restore_config_backup", { path: "rotate.yaml" });
  assert.ok(!r.isError, r.text);
  assert.equal(await read("rotate.yaml"), "n: 23\n");
});

// ------------------------------------------------------------------ secrets

test("set_secret / delete_secret never return or log the value", async () => {
  const VALUE = "p@ss: 'w0rd' #1";
  const r = await srv.call("ha_set_secret", { name: "mqtt_password", secret_value: VALUE });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.action, "added");
  assert.ok(!r.text.includes(VALUE));
  const text = await read("secrets.yaml");
  assert.match(text, /^# secrets\n/);
  assert.ok(text.includes(`mqtt_password: "p@ss: 'w0rd' #1"`), text);
  assert.match(text, new RegExp(SECRET_1));

  const u = await srv.call("ha_set_secret", { name: "mqtt_password", secret_value: "12345" });
  assert.equal(u.json.action, "updated");
  assert.match(await read("secrets.yaml"), /mqtt_password: "12345"/);
  assert.ok(u.json.backup_id);

  const rd = await srv.call("ha_read_config_file", { path: "secrets.yaml" });
  assert.ok(rd.json.secret_names.includes("mqtt_password"));
  assert.ok(!rd.text.includes("12345"));

  const del = await srv.call("ha_delete_secret", { name: "mqtt_password" });
  assert.ok(!del.isError, del.text);
  assert.ok(!(await read("secrets.yaml")).includes("mqtt_password"));
  const del2 = await srv.call("ha_delete_secret", { name: "mqtt_password" });
  assert.ok(del2.isError);
  const wrong = await srv.call("ha_set_secret", { name: "x", secret_value: "y", file: "configuration.yaml" });
  assert.ok(wrong.isError);

  // restore of secrets.yaml works but shows no diff
  const rs = await srv.call("ha_restore_config_backup", { path: "secrets.yaml" });
  assert.ok(!rs.isError, rs.text);
  assert.equal(rs.json.diff, undefined);
  assert.ok(!rs.text.includes("12345") && !rs.text.includes(SECRET_1));

  await new Promise((res) => setTimeout(res, 200));
  const logs = srv.logs.join("");
  assert.match(logs, /tool ha_set_secret .*"secret_value":"\*\*\*"/);
  for (const v of [VALUE, "12345", SECRET_1, SECRET_2]) assert.ok(!logs.includes(v), `value leaked to logs: ${v}`);
});

// ------------------------------------------------------------------ check / reload

test("check_config and reload request shapes", async () => {
  const start = fake.requests.length;
  const c = await srv.call("ha_check_config");
  assert.ok(!c.isError, c.text);
  assert.deepEqual(c.json, { result: "valid", valid: true, errors: null });

  const r = await srv.call("ha_reload_config", { target: "automation" });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.reloaded, "automation.reload");
  const reqs = fake.requests.slice(start).filter((x) => x.kind === "rest").map((x) => `${x.method} ${x.path}`);
  assert.deepEqual(reqs, [
    "POST /api/config/core/check_config",
    "POST /api/config/core/check_config",
    "POST /api/services/automation/reload",
  ]);

  const s2 = fake.requests.length;
  await srv.call("ha_reload_config", { target: "all", check_first: false });
  await srv.call("ha_reload_config", { target: "core", check_first: false });
  await srv.call("ha_reload_config", { target: "custom_templates", check_first: false });
  await srv.call("ha_reload_config", { target: "input_boolean", check_first: false });
  assert.deepEqual(fake.requests.slice(s2).map((x) => x.path), [
    "/api/services/homeassistant/reload_all",
    "/api/services/homeassistant/reload_core_config",
    "/api/services/homeassistant/reload_custom_templates",
    "/api/services/input_boolean/reload",
  ]);

  checkResult = { result: "invalid", errors: "Integration error: foo - Integration 'foo' not found." };
  try {
    const s3 = fake.requests.length;
    const bad = await srv.call("ha_reload_config", { target: "script" });
    assert.ok(bad.isError);
    assert.match(bad.text, /invalid.*Integration 'foo' not found/);
    assert.deepEqual(fake.requests.slice(s3).map((x) => x.path), ["/api/config/core/check_config"]);
    const c2 = await srv.call("ha_check_config");
    assert.equal(c2.json.valid, false);
    assert.match(c2.json.errors, /foo/);
  } finally {
    checkResult = { result: "valid", errors: null };
  }

  const unknown = await srv.call("ha_reload_config", { target: "lock" });
  assert.ok(unknown.isError);
});

test("reload respects the HA client error path (service failure surfaces as tool error)", async () => {
  fake.rest["POST /api/services/scene/reload"] = () => reply(500, "boom");
  try {
    const r = await srv.call("ha_reload_config", { target: "scene", check_first: false });
    assert.ok(r.isError);
    assert.match(r.text, /500/);
  } finally {
    delete fake.rest["POST /api/services/scene/reload"];
  }
});
