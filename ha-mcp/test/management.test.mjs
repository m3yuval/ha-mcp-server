// Management tools (ENABLE_MANAGEMENT): payloads sent to Home Assistant.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startFakeHA, startMcp, reply } from "./helpers/harness.mjs";

const now = new Date().toISOString();
const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes, last_changed: now, last_updated: now });

let flowStep = 0;
let configValid = true;
const savedConfigs = new Map([["1700000000000", { id: "1700000000000", alias: "Old", triggers: [], actions: [] }]]);

const fake = await startFakeHA({
  rest: {
    "GET /api/states": () => [
      st("light.kitchen", "on", { friendly_name: "Kitchen Light" }),
      st("automation.morning", "on", { friendly_name: "Morning", id: "1700000000000", last_triggered: now }),
      st("script.bedtime", "off", { friendly_name: "Bedtime" }),
      st("update.core", "on", { friendly_name: "Core update", installed_version: "2026.9.0", latest_version: "2026.9.1" }),
      st("update.zigbee_fw", "off", { friendly_name: "Zigbee firmware", installed_version: "1.0", latest_version: "1.0" }),
    ],
    // config entries
    "POST /api/config/config_entries/entry/*": () => ({ require_restart: false }),
    "DELETE /api/config/config_entries/entry/*": () => ({ require_restart: false }),
    // config flow
    "POST /api/config/config_entries/flow": ({ body }) => {
      flowStep = 1;
      return {
        type: "form",
        flow_id: "flow1",
        handler: body.handler,
        step_id: "user",
        data_schema: [
          { name: "host", required: true, type: "string" },
          { name: "port", optional: true, default: 80, type: "integer" },
          { name: "mode", required: true, selector: { select: { options: ["a", { value: "b", label: "B" }] } } },
        ],
        errors: {},
        last_step: null,
      };
    },
    "GET /api/config/config_entries/flow/*": () => ({
      type: "form", flow_id: "flow1", handler: "demo", step_id: "user", data_schema: [], errors: {},
    }),
    "POST /api/config/config_entries/flow/*": ({ body }) => {
      if (!body.host) {
        return { type: "form", flow_id: "flow1", handler: "demo", step_id: "user", data_schema: [{ name: "host", required: true, type: "string" }], errors: { base: "cannot_connect" } };
      }
      flowStep = 2;
      return { type: "create_entry", flow_id: "flow1", handler: "demo", title: "Demo", version: 1, result: { entry_id: "new_entry", domain: "demo", title: "Demo", state: "loaded" } };
    },
    "DELETE /api/config/config_entries/flow/*": () => ({ message: "Flow aborted" }),
    "POST /api/config/config_entries/options/flow": ({ body }) => ({
      type: "form", flow_id: "opt1", handler: body.handler, step_id: "init",
      data_schema: [{ name: "scan_interval", required: false, type: "integer", description: { suggested_value: 30 } }], errors: {},
    }),
    // automations / scripts / scenes
    "GET /api/config/automation/config/*": ({ path }) => {
      const id = path.split("/").pop();
      if (!savedConfigs.has(id)) throw { status: 404, body: { message: "Resource not found" } };
      return savedConfigs.get(id);
    },
    "POST /api/config/automation/config/*": () => ({ result: "ok" }),
    "DELETE /api/config/automation/config/*": () => ({ result: "ok" }),
    "GET /api/config/script/config/*": ({ path }) => {
      if (path.endsWith("/wake_up")) return { alias: "Wake up", sequence: [] };
      throw { status: 404, body: { message: "Resource not found" } };
    },
    "POST /api/config/script/config/*": () => ({ result: "ok" }),
    "POST /api/config/scene/config/*": () => ({ result: "ok" }),
    // system
    "POST /api/config/core/check_config": () => (configValid ? { result: "valid", errors: null } : { result: "invalid", errors: "bad yaml" }),
    "POST /api/services/homeassistant/restart": () => [],
    "POST /api/services/update/install": () => [],
    "POST /api/services/recorder/purge": () => [],
    "POST /api/services/recorder/purge_entities": () => [],
    "POST /api/services/logger/set_default_level": () => [],
    "GET /api/diagnostics/config_entry/*": () => ({ data: { ok: true } }),
  },
  ws: {
    "config_entries/get": () => [
      { entry_id: "e1", domain: "hue", title: "Hue Bridge", source: "user", state: "loaded", disabled_by: null, supports_options: true },
      { entry_id: "e2", domain: "mqtt", title: "Mosquitto", source: "hassio", state: "setup_error", disabled_by: null, reason: "boom" },
    ],
    "config_entries/flow/progress": () => [{ flow_id: "disc1", handler: "shelly", step_id: "confirm", context: { source: "zeroconf" } }],
    "config_entries/disable": () => ({ require_restart: false }),
    "config_entries/update": (m) => ({ require_restart: false, config_entry: { entry_id: m.entry_id, title: m.title } }),
    "integration/descriptions": () => ({
      core: {
        integration: {
          mqtt: { name: "MQTT", integration_type: "hub", config_flow: true, iot_class: "local_push" },
          yamlonly: { name: "YAML Only", integration_type: "service", config_flow: false },
          philips: { name: "Philips", integrations: { hue: { name: "Philips Hue", integration_type: "hub", config_flow: true } } },
        },
        helper: { input_boolean: { integration_type: "helper", config_flow: false }, template: { integration_type: "helper", config_flow: true } },
      },
      custom: { integration: {} },
    }),
    "frontend/get_translations": (m) => ({
      resources: m.integration?.includes("demo")
        ? {
            "component.demo.config.step.user.title": "Connect to Demo",
            "component.demo.config.step.user.data.host": "Host",
            "component.demo.config.error.cannot_connect": "Failed to connect",
          }
        : {},
    }),
    // registries
    "config/area_registry/list": () => [{ area_id: "kitchen", name: "Kitchen" }],
    "config/area_registry/create": (m) => ({ area_id: "garage", name: m.name }),
    "config/floor_registry/update": (m) => ({ floor_id: m.floor_id, name: m.name }),
    "config/label_registry/delete": () => null,
    "config/category_registry/create": (m) => ({ category_id: "c1", name: m.name }),
    "config/category_registry/list": () => [{ category_id: "c1", name: "Lights" }],
    "config/device_registry/list": () => [
      { id: "d1", name: "Hue Bulb", name_by_user: null, manufacturer: "Signify", model: "LCT", area_id: "kitchen", config_entries: ["e1"], labels: [], disabled_by: null },
      { id: "d2", name: "Old Sensor", name_by_user: "Porch", manufacturer: "Acme", area_id: null, config_entries: ["e2"], labels: [], disabled_by: "user" },
    ],
    "config/device_registry/update": (m) => ({ id: m.device_id, name_by_user: m.name_by_user }),
    "config/device_registry/remove_config_entry": () => null,
    "config/entity_registry/list": () => [
      { entity_id: "light.kitchen", platform: "hue", device_id: "d1", unique_id: "u1", disabled_by: null },
      { entity_id: "sensor.porch_temp", platform: "mqtt", device_id: "d2", unique_id: "u2", disabled_by: "user" },
      { entity_id: "script.bedtime", platform: "script", unique_id: "bedtime_routine" },
    ],
    "config/entity_registry/update": (m) => ({ entity_entry: { entity_id: m.new_entity_id ?? m.entity_id } }),
    "config/entity_registry/remove": () => null,
    // automations
    validate_config: (m) => {
      const out = {};
      for (const k of ["triggers", "conditions", "actions"]) {
        if (!(k in m)) continue;
        const bad = JSON.stringify(m[k]).includes("not_a_real_trigger");
        out[k] = { valid: !bad, error: bad ? "Invalid trigger" : null };
      }
      return out;
    },
    "trace/list": () => [
      { domain: "automation", item_id: "1700000000000", run_id: "r1", state: "stopped", script_execution: "finished", timestamp: { start: "2026-09-01T10:00:00Z", finish: "2026-09-01T10:00:01Z" }, trigger: "time" },
      { domain: "automation", item_id: "1700000000000", run_id: "r2", state: "stopped", script_execution: "error", timestamp: { start: "2026-09-02T10:00:00Z" }, error: "oops" },
    ],
    "trace/get": () => ({
      item_id: "1700000000000", run_id: "r2", state: "stopped", script_execution: "error", error: "oops",
      trace: { "trigger/0": [{ timestamp: "t", changed_variables: { trigger: {} } }], "action/0": [{ timestamp: "t2", error: "oops", result: { params: {} } }] },
      config: { alias: "Morning" },
    }),
    "blueprint/list": () => ({ "homeassistant/motion_light.yaml": { metadata: { name: "Motion light", domain: "automation", input: { motion_entity: { name: "Motion" } } } } }),
    "blueprint/import": () => ({
      suggested_filename: "someone/cool_bp",
      raw_data: "blueprint:\n  name: Cool\n  domain: automation\n",
      blueprint: { metadata: { name: "Cool", domain: "automation", input: {} } },
      validation_errors: null,
      exists: false,
    }),
    "blueprint/save": () => ({ overrides_existing: false }),
    "blueprint/delete": () => null,
    // helpers / people / zones / tags
    "input_boolean/list": () => [{ id: "guest_mode", name: "Guest mode" }],
    "input_boolean/create": (m) => ({ id: "guest_mode", name: m.name, icon: m.icon }),
    "input_boolean/update": (m) => ({ id: m.input_boolean_id, name: m.name }),
    "person/list": () => ({ storage: [{ id: "p1", name: "Alex" }], config: [] }),
    "person/update": (m) => ({ id: m.person_id, device_trackers: m.device_trackers }),
    "zone/delete": () => null,
    "tag/create": (m) => ({ id: m.tag_id ?? "generated", name: m.name }),
    "timer/create": (m) => ({ id: "t1", ...m }),
    // users
    "config/auth/list": () => [
      { id: "u1", name: "Owner", username: "owner", is_owner: true, is_active: true, system_generated: false, group_ids: ["system-admin"] },
      { id: "u2", name: "Supervisor", is_owner: false, is_active: true, system_generated: true, group_ids: ["system-admin"] },
    ],
    "config/auth/create": (m) => ({ user: { id: "newuser", name: m.name, group_ids: m.group_ids } }),
    "config/auth_provider/homeassistant/create": () => null,
    "config/auth/delete": () => null,
    "config/auth/update": (m) => ({ user: { id: m.user_id, name: m.name } }),
    "config/auth_provider/homeassistant/admin_change_password": () => null,
    // system
    "repairs/list_issues": () => ({ issues: [
      { domain: "hue", issue_id: "i1", severity: "warning", is_fixable: true, ignored: false, created: now },
      { domain: "mqtt", issue_id: "i2", severity: "error", is_fixable: false, ignored: true, created: now },
    ] }),
    "repairs/ignore_issue": () => null,
    "logger/integration_log_level": () => null,
    "logger/log_info": () => [{ domain: "zha", level: 10 }],
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

const reset = () => (fake.requests.length = 0);
const wsSent = (type) => fake.requests.filter((r) => r.kind === "ws" && r.type === type).map((r) => {
  const { id, type: _t, ...rest } = r.payload;
  return rest;
});
const restSent = (method, prefix) => fake.requests.filter((r) => r.kind === "rest" && r.method === method && r.path.startsWith(prefix));

async function call(name, args) {
  const r = await srv.call(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.text}`);
  return r.json ?? r.text;
}

const MANAGEMENT_TOOLS = [
  "ha_delete_automation_config", "ha_get_automation_config", "ha_get_automation_traces", "ha_get_integration_diagnostics",
  "ha_ignore_repair", "ha_install_update", "ha_integration_flow", "ha_list_automation_configs", "ha_list_available_integrations",
  "ha_list_blueprints", "ha_list_devices", "ha_list_entity_registry", "ha_list_helpers", "ha_list_integrations",
  "ha_list_registry", "ha_list_repairs", "ha_list_updates", "ha_list_users", "ha_manage_area", "ha_manage_blueprint",
  "ha_manage_category", "ha_manage_device", "ha_manage_entity", "ha_manage_floor", "ha_manage_helper",
  "ha_manage_integration", "ha_manage_label", "ha_manage_user", "ha_purge_recorder", "ha_restart",
  "ha_save_automation_config", "ha_set_log_level",
];

test("management tools are not registered without ENABLE_MANAGEMENT", async () => {
  const plain = await startMcp({ fake });
  try {
    const names = await plain.toolNames();
    for (const n of MANAGEMENT_TOOLS) assert.ok(!names.includes(n), `${n} should not be registered`);
  } finally {
    await plain.stop();
  }
});

test("all management tools registered with sensible annotations", async () => {
  const tools = await srv.tools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of MANAGEMENT_TOOLS) assert.ok(byName[n], `${n} missing`);
  const destructive = [
    "ha_manage_integration", "ha_manage_area", "ha_manage_floor", "ha_manage_label", "ha_manage_category",
    "ha_manage_device", "ha_manage_entity", "ha_save_automation_config", "ha_delete_automation_config",
    "ha_manage_helper", "ha_manage_user", "ha_manage_blueprint", "ha_restart", "ha_install_update", "ha_purge_recorder",
    "ha_integration_flow",
  ];
  for (const n of destructive) {
    assert.equal(byName[n].annotations?.destructiveHint, true, `${n} must be destructive`);
    assert.equal(byName[n].annotations?.readOnlyHint, false, n);
  }
  for (const n of MANAGEMENT_TOOLS.filter((n) => /^ha_(list|get)_/.test(n))) {
    assert.equal(byName[n].annotations?.readOnlyHint, true, `${n} must be read-only`);
  }
  for (const n of ["ha_ignore_repair", "ha_set_log_level"]) {
    assert.equal(byName[n].annotations?.readOnlyHint, false, n);
    assert.equal(byName[n].annotations?.destructiveHint, false, n);
  }
});

test("read-only list tools send no writes", async () => {
  reset();
  await call("ha_list_integrations", { state: "setup_error" });
  await call("ha_list_devices", { domain: "hue" });
  await call("ha_list_entity_registry", { status: "disabled" });
  await call("ha_list_repairs", {});
  await call("ha_list_updates", {});
  await call("ha_list_registry", { registry: "area" });
  assert.deepEqual(fake.writes(), []);
});

// ------------------------------------------------------------ integrations

test("integrations: list, available, manage", async () => {
  reset();
  const list = await call("ha_list_integrations", { state: "setup_error" });
  assert.deepEqual(list.entries.map((e) => e.entry_id), ["e2"]);
  assert.equal(list.discovered[0].handler, "shelly");

  const avail = await call("ha_list_available_integrations", { search: "hue" });
  assert.deepEqual(avail.integrations.map((i) => i.domain), ["hue"]);
  assert.equal(avail.integrations[0].brand, "Philips");
  const all = await call("ha_list_available_integrations", {});
  assert.ok(!all.integrations.some((i) => i.domain === "yamlonly"));
  assert.ok(all.integrations.some((i) => i.domain === "template"));

  reset();
  await call("ha_manage_integration", { action: "disable", entry_id: "e1" });
  await call("ha_manage_integration", { action: "enable", entry_id: "e1" });
  assert.deepEqual(wsSent("config_entries/disable"), [
    { entry_id: "e1", disabled_by: "user" },
    { entry_id: "e1", disabled_by: null },
  ]);
  await call("ha_manage_integration", { action: "update", entry_id: "e1", title: "Hue Upstairs" });
  assert.deepEqual(wsSent("config_entries/update"), [{ entry_id: "e1", title: "Hue Upstairs" }]);
  await call("ha_manage_integration", { action: "reload", entry_id: "e1" });
  assert.equal(restSent("POST", "/api/config/config_entries/entry/e1/reload").length, 1);
  await call("ha_manage_integration", { action: "delete", entry_id: "e2" });
  assert.equal(restSent("DELETE", "/api/config/config_entries/entry/e2").length, 1);

  const diag = await call("ha_get_integration_diagnostics", { entry_id: "e1" });
  assert.deepEqual(diag, { data: { ok: true } });
});

test("config flow: start -> step with error -> step -> create_entry", async () => {
  reset();
  const start = await call("ha_integration_flow", { action: "start", handler: "demo" });
  assert.deepEqual(restSent("POST", "/api/config/config_entries/flow")[0].body, { handler: "demo" });
  assert.equal(start.type, "form");
  assert.equal(start.flow_id, "flow1");
  assert.equal(start.title, "Connect to Demo");
  assert.deepEqual(start.fields, [
    { name: "host", label: "Host", required: true, type: "string" },
    { name: "port", required: false, type: "integer", default: 80 },
    { name: "mode", required: true, type: "select", choices: ["a", "b"] },
  ]);
  assert.match(start.next, /action='step'/);

  const bad = await call("ha_integration_flow", { action: "step", flow_id: "flow1", user_input: {} });
  assert.deepEqual(bad.errors, { base: "cannot_connect: Failed to connect" });

  const done = await call("ha_integration_flow", { action: "step", flow_id: "flow1", user_input: { host: "10.0.0.2", mode: "a" } });
  assert.equal(done.type, "create_entry");
  assert.equal(done.result.entry_id, "new_entry");
  const steps = restSent("POST", "/api/config/config_entries/flow/flow1").map((r) => r.body);
  assert.deepEqual(steps, [{}, { host: "10.0.0.2", mode: "a" }]);

  await call("ha_integration_flow", { action: "abort", flow_id: "flow1" });
  assert.equal(restSent("DELETE", "/api/config/config_entries/flow/flow1").length, 1);
});

test("config flow: reconfigure and options flow", async () => {
  reset();
  await call("ha_integration_flow", { action: "start", handler: "hue", entry_id: "e1" });
  assert.deepEqual(restSent("POST", "/api/config/config_entries/flow")[0].body, { handler: "hue", entry_id: "e1" });
  const opt = await call("ha_integration_flow", { action: "start", flow: "options", handler: "e1" });
  assert.deepEqual(restSent("POST", "/api/config/config_entries/options/flow")[0].body, { handler: "e1" });
  assert.equal(opt.fields[0].current_value, 30);
  const bad = await srv.call("ha_integration_flow", { action: "step" });
  assert.ok(bad.isError);
  assert.match(bad.text, /flow_id/);
});

// -------------------------------------------------------------- registries

test("registries: area/floor/label/category payloads", async () => {
  reset();
  await call("ha_manage_area", { action: "create", name: "Garage", floor_id: "ground", aliases: ["car room"] });
  assert.deepEqual(wsSent("config/area_registry/create"), [{ name: "Garage", floor_id: "ground", aliases: ["car room"] }]);
  await call("ha_manage_floor", { action: "update", floor_id: "ground", name: "Ground", level: 0 });
  assert.deepEqual(wsSent("config/floor_registry/update"), [{ floor_id: "ground", name: "Ground", level: 0 }]);
  await call("ha_manage_label", { action: "delete", label_id: "old" });
  assert.deepEqual(wsSent("config/label_registry/delete"), [{ label_id: "old" }]);
  await call("ha_manage_category", { action: "create", scope: "automation", name: "Lights", icon: "mdi:lightbulb" });
  assert.deepEqual(wsSent("config/category_registry/create"), [{ scope: "automation", name: "Lights", icon: "mdi:lightbulb" }]);
  const cats = await call("ha_list_registry", { registry: "category", scope: "automation" });
  assert.equal(cats[0].category_id, "c1");
  const r = await srv.call("ha_manage_area", { action: "update", area_id: "kitchen" });
  assert.ok(r.isError, "update with no fields must fail");
  const r2 = await srv.call("ha_manage_area", { action: "create" });
  assert.ok(r2.isError);
});

test("devices and entities: list, update, remove", async () => {
  reset();
  const devs = await call("ha_list_devices", { domain: "mqtt" });
  assert.deepEqual(devs.devices.map((d) => d.id), ["d2"]);
  assert.equal(devs.devices[0].name, "Porch");
  assert.deepEqual(devs.devices[0].integrations, ["mqtt"]);

  await call("ha_manage_device", { action: "update", device_id: "d1", name_by_user: "Ceiling", area_id: null, labels: ["l1"] });
  assert.deepEqual(wsSent("config/device_registry/update"), [{ device_id: "d1", name_by_user: "Ceiling", area_id: null, labels: ["l1"] }]);

  // Fake HA has no config/device_registry/remove -> falls back to remove_config_entry
  await call("ha_manage_device", { action: "remove", device_id: "d2" });
  assert.deepEqual(wsSent("config/device_registry/remove"), [{ device_id: "d2" }]);
  assert.deepEqual(wsSent("config/device_registry/remove_config_entry"), [{ device_id: "d2", config_entry_id: "e2" }]);

  await call("ha_manage_entity", { action: "update", entity_id: "sensor.porch_temp", disabled_by: null, new_entity_id: "sensor.porch", name: "Porch" });
  assert.deepEqual(wsSent("config/entity_registry/update"), [
    { entity_id: "sensor.porch_temp", disabled_by: null, new_entity_id: "sensor.porch", name: "Porch" },
  ]);
  await call("ha_manage_entity", { action: "remove", entity_id: "sensor.porch" });
  assert.deepEqual(wsSent("config/entity_registry/remove"), [{ entity_id: "sensor.porch" }]);
});

// ------------------------------------------------------------- automations

test("automation create validates then saves", async () => {
  reset();
  const config = { alias: "Night", trigger: [{ trigger: "time", at: "22:00" }], action: [{ action: "light.turn_off" }] };
  const res = await call("ha_save_automation_config", { kind: "automation", config });
  assert.equal(res.saved, true);
  assert.equal(res.created, true);
  assert.match(res.id, /^\d+$/);
  const kinds = fake.requests.map((r) => (r.kind === "ws" ? r.type : `${r.method} ${r.path}`));
  const vi = kinds.indexOf("validate_config");
  const pi = kinds.indexOf(`POST /api/config/automation/config/${res.id}`);
  assert.ok(vi >= 0 && pi > vi, `validate must precede save: ${kinds.join(", ")}`);
  assert.deepEqual(wsSent("validate_config"), [{ triggers: config.trigger, actions: config.action }]);
  assert.deepEqual(restSent("POST", "/api/config/automation/config/")[0].body, config);
});

test("invalid automation is not saved; validate_only never saves", async () => {
  reset();
  const bad = await call("ha_save_automation_config", {
    kind: "automation",
    config: { alias: "Bad", triggers: [{ trigger: "not_a_real_trigger" }], actions: [] },
  });
  assert.equal(bad.saved, false);
  assert.equal(bad.validation.triggers.valid, false);
  await call("ha_save_automation_config", { kind: "automation", config: { alias: "X", triggers: [], actions: [] }, validate_only: true });
  assert.equal(restSent("POST", "/api/config/automation").length, 0);
});

test("automation update, get, delete, list; script id from alias; scene", async () => {
  reset();
  const upd = await call("ha_save_automation_config", {
    kind: "automation", id: "1700000000000", config: { id: "1700000000000", alias: "Morning", triggers: [], actions: [] },
  });
  assert.equal(upd.created, false);
  assert.deepEqual(restSent("POST", "/api/config/automation/config/1700000000000")[0].body, { alias: "Morning", triggers: [], actions: [] });

  const got = await call("ha_get_automation_config", { kind: "automation", id: "1700000000000" });
  assert.equal(got.alias, "Old");

  await call("ha_delete_automation_config", { kind: "automation", id: "1700000000000" });
  assert.equal(restSent("DELETE", "/api/config/automation/config/1700000000000").length, 1);

  const list = await call("ha_list_automation_configs", { kind: "script" });
  assert.deepEqual(list.items, [{ entity_id: "script.bedtime", id: "bedtime_routine", name: "Bedtime", state: "off", editable: true }]);

  reset();
  // "wake_up" exists already -> wake_up_2
  const s = await call("ha_save_automation_config", { kind: "script", config: { alias: "Wake up", sequence: [{ delay: 1 }] } });
  assert.equal(s.id, "wake_up_2");
  assert.equal(s.entity_id, "script.wake_up_2");
  assert.deepEqual(wsSent("validate_config"), [{ actions: [{ delay: 1 }] }]);
  assert.equal(restSent("POST", "/api/config/script/config/wake_up_2").length, 1);

  reset();
  await call("ha_save_automation_config", { kind: "scene", config: { name: "Movie", entities: { "light.kitchen": "off" } } });
  assert.equal(wsSent("validate_config").length, 0);
  assert.deepEqual(restSent("POST", "/api/config/scene/config/")[0].body, { name: "Movie", entities: { "light.kitchen": "off" } });
});

test("traces: list and compact get", async () => {
  reset();
  const runs = await call("ha_get_automation_traces", { domain: "automation", item_id: "1700000000000" });
  assert.deepEqual(wsSent("trace/list"), [{ domain: "automation", item_id: "1700000000000" }]);
  assert.equal(runs[0].run_id, "r2", "newest first");
  const t = await call("ha_get_automation_traces", { domain: "automation", item_id: "1700000000000", run_id: "r2" });
  assert.deepEqual(wsSent("trace/get"), [{ domain: "automation", item_id: "1700000000000", run_id: "r2" }]);
  assert.equal(t.steps["action/0"][0].error, "oops");
});

test("blueprints: list, import (import + save), delete", async () => {
  reset();
  const list = await call("ha_list_blueprints", { domain: "automation" });
  assert.equal(list[0].path, "homeassistant/motion_light.yaml");
  const url = "https://example.com/cool_bp.yaml";
  const res = await call("ha_manage_blueprint", { action: "import", url });
  assert.equal(res.saved, true);
  assert.deepEqual(wsSent("blueprint/import"), [{ url }]);
  assert.deepEqual(wsSent("blueprint/save"), [
    { domain: "automation", path: "someone/cool_bp", yaml: "blueprint:\n  name: Cool\n  domain: automation\n", source_url: url },
  ]);
  await call("ha_manage_blueprint", { action: "delete", domain: "automation", path: "someone/cool_bp.yaml" });
  assert.deepEqual(wsSent("blueprint/delete"), [{ domain: "automation", path: "someone/cool_bp.yaml" }]);
});

// ----------------------------------------------------------------- helpers

test("helpers, people, zones, tags: payloads", async () => {
  reset();
  const all = await call("ha_list_helpers", {});
  assert.equal(all.input_boolean[0].id, "guest_mode");
  assert.equal(all.person.storage[0].name, "Alex");
  assert.ok(all.counter.error, "unknown domain reports an error instead of failing");

  reset();
  await call("ha_manage_helper", { domain: "input_boolean", action: "create", config: { name: "Guest mode", icon: "mdi:account" } });
  assert.deepEqual(wsSent("input_boolean/create"), [{ name: "Guest mode", icon: "mdi:account" }]);
  await call("ha_manage_helper", { domain: "input_boolean", action: "update", id: "guest_mode", config: { name: "Guests" } });
  assert.deepEqual(wsSent("input_boolean/update"), [{ input_boolean_id: "guest_mode", name: "Guests" }]);
  await call("ha_manage_helper", { domain: "timer", action: "create", config: { name: "Tea", duration: "00:04:00" } });
  assert.deepEqual(wsSent("timer/create"), [{ name: "Tea", duration: "00:04:00" }]);
  await call("ha_manage_helper", { domain: "person", action: "update", id: "p1", config: { device_trackers: ["device_tracker.phone"] } });
  assert.deepEqual(wsSent("person/update"), [{ person_id: "p1", device_trackers: ["device_tracker.phone"] }]);
  await call("ha_manage_helper", { domain: "zone", action: "delete", id: "z1" });
  assert.deepEqual(wsSent("zone/delete"), [{ zone_id: "z1" }]);
  await call("ha_manage_helper", { domain: "tag", action: "create", config: { tag_id: "abc", name: "Door tag" } });
  assert.deepEqual(wsSent("tag/create"), [{ tag_id: "abc", name: "Door tag" }]);
});

test("users: list hides system users; create with login; delete", async () => {
  reset();
  const users = await call("ha_list_users", {});
  assert.deepEqual(users.map((u) => u.id), ["u1"]);
  const created = await call("ha_manage_user", { action: "create", name: "Guest", username: "guest", password: "s3cret-pw", confirm: true });
  assert.ok(!JSON.stringify(created).includes("s3cret-pw"), "password must not be echoed");
  assert.deepEqual(wsSent("config/auth/create"), [{ name: "Guest", group_ids: ["system-users"] }]);
  assert.deepEqual(wsSent("config/auth_provider/homeassistant/create"), [{ user_id: "newuser", username: "guest", password: "s3cret-pw" }]);
  await call("ha_manage_user", { action: "delete", user_id: "newuser", confirm: true });
  assert.deepEqual(wsSent("config/auth/delete"), [{ user_id: "newuser" }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!srv.logs.join("").includes("s3cret-pw"), "password must not be logged");
});

test("users: create/admin/set_password/delete/group changes/deactivate require confirm; nothing sent without it", async () => {
  const attempts = [
    [{ action: "create", name: "Guest" }, /create a user account/],
    [{ action: "create", name: "Boss", group_ids: ["system-admin"], username: "boss", password: "adm1n-pw" }, /ADMINISTRATOR/],
    [{ action: "set_password", user_id: "u1", password: "n3w-pw-value" }, /set the password/],
    [{ action: "delete", user_id: "u1" }, /delete user/],
    [{ action: "update", user_id: "u1", group_ids: ["system-admin"] }, /granting administrator/],
    [{ action: "update", user_id: "u1", group_ids: ["system-users"] }, /change the groups/],
    [{ action: "update", user_id: "u1", is_active: false }, /deactivate/],
    [{ action: "update", user_id: "u1", name: "X", confirm: false, group_ids: ["system-admin"] }, /confirm/],
  ];
  for (const [args, re] of attempts) {
    reset();
    const r = await srv.call("ha_manage_user", args);
    assert.ok(r.isError, JSON.stringify(args));
    assert.match(r.text, re);
    assert.match(r.text, /confirm: true/);
    assert.deepEqual(fake.writes(), [], `${JSON.stringify(args)} sent a write`);
  }

  reset();
  const set = await call("ha_manage_user", { action: "set_password", user_id: "u1", password: "n3w-pw-value", confirm: true });
  assert.ok(!JSON.stringify(set).includes("n3w-pw-value"), "password must not be echoed");
  assert.deepEqual(wsSent("config/auth_provider/homeassistant/admin_change_password"), [{ user_id: "u1", password: "n3w-pw-value" }]);

  reset();
  const admin = await call("ha_manage_user", { action: "create", name: "Boss", group_ids: ["system-admin"], username: "boss", password: "adm1n-pw", confirm: true });
  assert.ok(!JSON.stringify(admin).includes("adm1n-pw"));
  assert.deepEqual(wsSent("config/auth/create"), [{ name: "Boss", group_ids: ["system-admin"] }]);

  // Renames and local_only need no confirm.
  reset();
  await call("ha_manage_user", { action: "update", user_id: "u1", name: "Renamed", local_only: true });
  assert.deepEqual(wsSent("config/auth/update"), [{ user_id: "u1", name: "Renamed", local_only: true }]);

  await new Promise((r) => setTimeout(r, 100));
  const logs = srv.logs.join("");
  for (const pw of ["n3w-pw-value", "adm1n-pw"]) assert.ok(!logs.includes(pw), `${pw} logged`);
});

// ------------------------------------------------------------------ system

test("restart requires confirm and checks config first", async () => {
  reset();
  const noConfirm = await srv.call("ha_restart", {});
  assert.ok(noConfirm.isError);
  const falseConfirm = await srv.call("ha_restart", { confirm: false });
  assert.ok(falseConfirm.isError);
  assert.deepEqual(fake.writes(), []);

  configValid = false;
  const refused = await call("ha_restart", { confirm: true });
  assert.equal(refused.restarted, false);
  assert.equal(restSent("POST", "/api/services/homeassistant/restart").length, 0);
  configValid = true;

  reset();
  const ok = await call("ha_restart", { confirm: true });
  assert.equal(ok.restarted, true);
  const order = fake.requests.map((r) => r.path);
  assert.deepEqual(order, ["/api/config/core/check_config", "/api/services/homeassistant/restart"]);
});

test("repairs, updates, log level, recorder purge", async () => {
  reset();
  const issues = await call("ha_list_repairs", {});
  assert.deepEqual(issues.map((i) => i.issue_id), ["i1"]);
  await call("ha_ignore_repair", { domain: "hue", issue_id: "i1" });
  assert.deepEqual(wsSent("repairs/ignore_issue"), [{ domain: "hue", issue_id: "i1", ignore: true }]);

  const updates = await call("ha_list_updates", {});
  assert.deepEqual(updates.map((u) => u.entity_id), ["update.core"]);
  assert.equal(updates[0].latest_version, "2026.9.1");
  await call("ha_install_update", { entity_id: "update.core", backup: true });
  assert.deepEqual(restSent("POST", "/api/services/update/install")[0].body, { entity_id: "update.core", backup: true });
  const badUpd = await srv.call("ha_install_update", { entity_id: "light.kitchen" });
  assert.ok(badUpd.isError);

  await call("ha_set_log_level", { integration: "zha", level: "debug" });
  assert.deepEqual(wsSent("logger/integration_log_level"), [{ integration: "zha", level: "DEBUG", persistence: "none" }]);
  await call("ha_set_log_level", { level: "warning" });
  assert.deepEqual(restSent("POST", "/api/services/logger/set_default_level")[0].body, { level: "warning" });

  const noConfirm = await srv.call("ha_purge_recorder", { keep_days: 5 });
  assert.ok(noConfirm.isError);
  await call("ha_purge_recorder", { confirm: true, keep_days: 5, repack: true });
  assert.deepEqual(restSent("POST", "/api/services/recorder/purge")[0].body, { keep_days: 5, repack: true });
  await call("ha_purge_recorder", { confirm: true, entity_id: ["sensor.porch"] });
  assert.deepEqual(restSent("POST", "/api/services/recorder/purge_entities")[0].body, { entity_id: ["sensor.porch"] });
});
