// The HA client must refuse anything that could change state unless the
// matching capability is enabled — before any network call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HAClient, BLOCKED_DOMAINS_LIMITS, SYSTEM_SERVICES, systemServiceLevel } from "../dist/ha-client.js";
import { startFakeHA, reply, HA_TOKEN } from "./helpers/harness.mjs";

// Port 9 (discard): if a request were actually sent it would fail with a
// connection error, not with the "Refusing" message we assert on.
const base = { baseUrl: "http://127.0.0.1:9", token: "x", timeoutMs: 500 };
const readOnly = new HAClient(base);

test("read-only client refuses every write path", async () => {
  for (const cap of ["actions", "config", "management"]) {
    await assert.rejects(() => readOnly.post("/api/config/automation/config/x", {}, cap), /capability is disabled/, cap);
    await assert.rejects(() => readOnly.delete("/api/config/automation/config/x", cap), /capability is disabled/, cap);
    await assert.rejects(() => readOnly.ws("config/area_registry/create", { name: "x" }, cap), /capability is disabled/, cap);
  }
  await assert.rejects(() => readOnly.callService("light", "turn_on", {}, "actions"), /capability is disabled/);
  await assert.rejects(() => readOnly.supervisor("POST", "/addons/x/restart"), /management' capability is disabled/);
});

test("'read' can never be used as a write capability", async () => {
  const all = new HAClient({ ...base, capabilities: ["actions", "config", "management"] });
  await assert.rejects(() => all.post("/api/config/x", {}, "read"), /Refusing write request/);
  await assert.rejects(() => all.ws("config/area_registry/create", {}, "read"), /Refusing write request/);
});

test("service calls must go through callService", async () => {
  const c = new HAClient({ ...base, capabilities: ["actions"] });
  await assert.rejects(() => c.post("/api/services/light/turn_on", {}, "actions"), /Use callService/);
  await assert.rejects(() => c.ws("call_service", { domain: "light" }, "actions"), /Use callService/);
});

test("capability only unlocks itself", async () => {
  const c = new HAClient({ ...base, capabilities: ["actions"] });
  await assert.rejects(() => c.post("/api/config/automation/config/x", {}, "config"), /'config' capability is disabled/);
  await assert.rejects(() => c.supervisor("GET", "/addons"), /'management' capability is disabled/);
});

test("refuses non-API paths", async () => {
  await assert.rejects(() => readOnly.get("/auth/token"), /Refusing non-API path/);
});

test("refuses websocket commands outside the read allowlist", async () => {
  for (const cmd of ["call_service", "config/area_registry/update", "execute_script", "fire_event"]) {
    await assert.rejects(() => readOnly.wsRead(cmd), /Refusing websocket command/, cmd);
  }
});

test("blocked domains: direct domain and explicit entities", async () => {
  const c = new HAClient({ ...base, capabilities: ["actions"], blockedDomains: ["lock", "Alarm_Control_Panel"] });
  await assert.rejects(() => c.callService("lock", "unlock", {}, "actions"), /Domain 'lock' is blocked/);
  await assert.rejects(() => c.callService("alarm_control_panel", "alarm_disarm", {}, "actions"), /blocked/);
  await assert.rejects(
    () => c.callService("homeassistant", "turn_off", { target: { entity_id: ["light.a", "lock.front"] } }, "actions"),
    /blocked entities \(lock\.front\)/,
  );
  await assert.rejects(
    () => c.callService("homeassistant", "turn_off", { data: { entity_id: "lock.front" } }, "actions"),
    /blocked entities/,
  );
  await assert.rejects(() => c.callService("homeassistant", "turn_off", { target: { entity_id: "all" } }, "actions"), /'all' is not allowed/);
  await assert.rejects(() => c.callService("light", "turn_on; rm", {}, "actions"), /Invalid service name/);
});

// ------------------------------------------------------------ H1: system services

const NOT_SENT_BUT_ALLOWED = /Could not reach/; // got past every gate, then hit port 9

test("H1: system-level actions are refused with the 'actions' capability", async () => {
  const c = new HAClient({ ...base, capabilities: ["actions"] });
  const refused = [
    ["hassio", "host_shutdown"],
    ["hassio", "host_reboot"],
    ["hassio", "addon_stop"],
    ["hassio", "addon_stdin"],
    ["hassio", "backup_full"],
    ["hassio", "restore_full"],
    ["homeassistant", "stop"],
    ["homeassistant", "restart"],
    ["homeassistant", "set_location"],
    ["homeassistant", "save_persistent_states"],
    ["update", "install"],
    ["backup", "create"],
    ["recorder", "purge"],
    ["logger", "set_level"],
    ["system_log", "clear"],
    ["cloud", "remote_connect"],
  ];
  for (const [d, s] of refused) {
    await assert.rejects(() => c.callService(d, s, {}, "actions"), /system-level action.*'enable_management'/, `${d}.${s}`);
  }
  for (const [d, s] of [["homeassistant", "reload_all"], ["homeassistant", "reload_core_config"], ["automation", "reload"], ["frontend", "reload_themes"]]) {
    await assert.rejects(() => c.callService(d, s, {}, "actions"), /system-level action.*'enable_config_files'/, `${d}.${s}`);
  }
  for (const [d, s] of [["homeassistant", "turn_on"], ["homeassistant", "turn_off"], ["homeassistant", "toggle"], ["homeassistant", "update_entity"], ["frontend", "set_theme"], ["light", "turn_on"]]) {
    await assert.rejects(() => c.callService(d, s, {}, "actions"), NOT_SENT_BUT_ALLOWED, `${d}.${s}`);
  }
});

test("H1: reloads work with 'config', everything with 'management'", async () => {
  const cfg = new HAClient({ ...base, capabilities: ["config"] });
  for (const [d, s] of [["homeassistant", "reload_all"], ["automation", "reload"], ["homeassistant", "reload_custom_templates"]]) {
    await assert.rejects(() => cfg.callService(d, s, {}, "config"), NOT_SENT_BUT_ALLOWED, `${d}.${s}`);
  }
  await assert.rejects(() => cfg.callService("homeassistant", "restart", {}, "config"), /'enable_management'/);
  const mgmt = new HAClient({ ...base, capabilities: ["management"] });
  for (const [d, s] of [["homeassistant", "restart"], ["update", "install"], ["logger", "set_default_level"], ["recorder", "purge"], ["homeassistant", "reload_all"]]) {
    await assert.rejects(() => mgmt.callService(d, s, {}, "management"), NOT_SENT_BUT_ALLOWED, `${d}.${s}`);
  }
});

test("H1: systemServiceLevel classification", () => {
  assert.equal(systemServiceLevel("hassio", "addon_stop"), "management");
  assert.equal(systemServiceLevel("homeassistant", "reload_all"), "config");
  assert.equal(systemServiceLevel("script", "reload"), "config");
  assert.equal(systemServiceLevel("homeassistant", "toggle"), null);
  assert.equal(systemServiceLevel("frontend", "set_theme"), null);
  assert.equal(systemServiceLevel("light", "turn_on"), null);
  assert.ok(SYSTEM_SERVICES.includes("hassio.*"));
});

// ------------------------------------------------------ H2/H4: blocked domains

test("H2: entity values are normalised (commas, spaces, case) and non-entity ids refused", async () => {
  const c = new HAClient({ ...base, capabilities: ["actions"], blockedDomains: ["lock"] });
  const off = (opts) => c.callService("homeassistant", "turn_off", opts, "actions");
  await assert.rejects(() => off({ data: { entity_id: "light.kitchen,lock.front_door" } }), /blocked entities \(lock\.front_door\)/);
  await assert.rejects(() => off({ target: { entity_id: "light.kitchen, lock.front_door" } }), /blocked entities \(lock\.front_door\)/);
  await assert.rejects(() => off({ target: { entity_id: " lock.front_door" } }), /blocked entities/);
  await assert.rejects(() => off({ target: { entity_id: ["LOCK.Front_Door"] } }), /blocked entities \(lock\.front_door\)/);
  await assert.rejects(() => off({ data: { entity_id: "0123456789abcdef0123456789abcdef" } }), /not a plain entity id/);
  await assert.rejects(() => off({ target: { entity_id: ["light.kitchen", "0123456789ABCDEF0123456789abcdef"] } }), /not a plain entity id/);
  await assert.rejects(() => off({ data: { entity_id: "ALL" } }), /'all' is not allowed/);
  await assert.rejects(() => off({ data: { entity_id: { nested: "x" } } }), /not a plain entity id/);
  // 'none' and ordinary ids pass the gate
  await assert.rejects(() => off({ target: { entity_id: ["none", "light.kitchen"] } }), NOT_SENT_BUT_ALLOWED);
  // Without blocked domains, registry ids are fine (HA resolves them)
  const open = new HAClient({ ...base, capabilities: ["actions"] });
  await assert.rejects(() => open.callService("light", "turn_on", { target: { entity_id: "0123456789abcdef0123456789abcdef" } }, "actions"), NOT_SENT_BUT_ALLOWED);
});

test("H4: blocked entities mentioned anywhere in data, and unsafe actions, are refused", async () => {
  const c = new HAClient({ ...base, capabilities: ["actions"], blockedDomains: ["lock", "alarm_control_panel"] });
  await assert.rejects(
    () => c.callService("script", "turn_on", { target: { entity_id: "script.x" }, data: { variables: { door: "Lock.Front_Door" } } }, "actions"),
    /mentions blocked entities \(lock\.front_door\)/,
  );
  await assert.rejects(
    () => c.callService("notify", "notify", { data: { message: "hi", data: { items: [{ "alarm_control_panel.home": 1 }] } } }, "actions"),
    /mentions blocked entities \(alarm_control_panel\.home\)/,
  );
  for (const s of ["apply", "create"]) {
    await assert.rejects(() => c.callService("scene", s, { data: { entities: {} } }, "actions"), /Refusing scene\.\w+ while blocked_domains/);
  }
  await assert.rejects(() => c.callService("group", "set", { data: { object_id: "x", entities: [] } }, "actions"), /group\.set while blocked_domains/);
  await assert.rejects(() => c.post("/api/intent/handle", { name: "HassTurnOff" }, "actions"), /intent API/);
  await assert.rejects(() => c.ws("execute_script", { sequence: [] }, "actions"), /execute_script.*blocked_domains/);
  await assert.rejects(() => c.ws("fire_event", { event_type: "x" }, "actions"), /fire_event.*blocked_domains/);
  // "clock.x" / "unlock.x" are not lock entities
  await assert.rejects(() => c.callService("notify", "notify", { data: { message: "clock.x unlock.y" } }, "actions"), NOT_SENT_BUT_ALLOWED);
});

test("BLOCKED_DOMAINS_LIMITS describes what blocked_domains can't cover", () => {
  for (const w of ["scripts", "automations", "python_script", "shell_command", "rest_command", "events", "not a security boundary"]) {
    assert.ok(BLOCKED_DOMAINS_LIMITS.includes(w), w);
  }
});

// -------------------------------------------- H3/H4 + M4 against a fake HA

test("H3/H4: labels expand via labelled devices and areas; groups via expand()", async () => {
  const templates = [];
  const fake = await startFakeHA({
    rest: {
      "POST /api/template": ({ body }) => {
        const t = body.template;
        templates.push(t);
        const out = [];
        if (t.includes('"security"') && t.includes("label_devices(l)") && t.includes("device_entities(dv)")) out.push("lock.front_door");
        if (t.includes('"porch"') && t.includes("label_areas(l)") && t.includes("area_entities(a)")) out.push("lock.porch");
        if (t.includes('"group.doors"') && t.includes("expand(ns.e)")) out.push("group.doors", "lock.back_door");
        return reply(200, JSON.stringify(out));
      },
      "POST /api/services/*": () => [],
    },
  });
  try {
    const c = new HAClient({ baseUrl: fake.haUrl, token: HA_TOKEN, capabilities: ["actions"], blockedDomains: ["lock"] });
    await assert.rejects(() => c.callService("homeassistant", "turn_off", { target: { label_id: "security" } }, "actions"), /lock\.front_door/);
    await assert.rejects(() => c.callService("homeassistant", "turn_off", { target: { label_id: "porch" } }, "actions"), /lock\.porch/);
    await assert.rejects(() => c.callService("homeassistant", "turn_off", { target: { entity_id: "group.doors" } }, "actions"), /lock\.back_door/);
    await assert.rejects(() => c.callService("homeassistant", "turn_off", { data: { label_id: "security" } }, "actions"), /lock\.front_door/);
    assert.ok(templates[0].includes("label_entities(l)"));
    // Nothing reached a service endpoint; an allowed label goes through.
    assert.equal(fake.requests.filter((r) => r.path?.startsWith("/api/services/")).length, 0);
    await c.callService("homeassistant", "turn_off", { target: { label_id: "garden" } }, "actions");
    assert.equal(fake.requests.filter((r) => r.path?.startsWith("/api/services/")).length, 1);
    // A plain light call needs no template at all
    const before = templates.length;
    await c.callService("light", "turn_on", { target: { entity_id: "light.kitchen" } }, "actions");
    assert.equal(templates.length, before);
  } finally {
    await fake.stop();
  }
});

test("H4: conversation.process via callService is checked against Assist exposure", async () => {
  let exposed = {};
  const fake = await startFakeHA({
    rest: { "POST /api/services/*": () => [], "POST /api/conversation/process": () => ({ response: {} }) },
    ws: { "homeassistant/expose_entity/list": () => ({ exposed_entities: exposed }) },
  });
  try {
    const c = new HAClient({ baseUrl: fake.haUrl, token: HA_TOKEN, capabilities: ["actions"], blockedDomains: ["lock"] });
    exposed = { "lock.front_door": { conversation: true } };
    await assert.rejects(() => c.callService("conversation", "process", { data: { text: "unlock" } }, "actions"), /Assist can control.*lock\.front_door/);
    await assert.rejects(() => c.post("/api/conversation/process", { text: "unlock" }, "actions"), /Assist can control/);
    await assert.rejects(() => c.ws("conversation/process", { text: "unlock" }, "actions"), /Assist can control/);
    exposed = { "lock.front_door": { conversation: false }, "light.kitchen": { conversation: true } };
    await c.callService("conversation", "process", { data: { text: "lights on" } }, "actions");
    assert.ok(fake.requests.some((r) => r.path === "/api/services/conversation/process"));
  } finally {
    await fake.stop();
  }
});

test("M4: renderTemplateWithTimeout uses websocket render_template with a timeout", async () => {
  const fake = await startFakeHA({
    ws: {
      render_template: (msg) => {
        if (msg.template.includes("range(")) {
          return { __error: { code: "template_error", message: `Exceeded maximum execution time of ${msg.timeout}s` } };
        }
        if (msg.template.includes("undefined_var")) {
          return { __events: [{ error: "'undefined_var' is undefined", level: "WARNING" }, { result: "", listeners: {} }] };
        }
        if (msg.template.includes("bad")) return { __events: [{ error: "TemplateSyntaxError: unexpected", level: "ERROR" }] };
        return { __events: [{ result: 2, listeners: { all: false } }] };
      },
    },
  });
  try {
    const c = new HAClient({ baseUrl: fake.haUrl, token: HA_TOKEN });
    assert.equal(await c.renderTemplateWithTimeout("{{ 1 + 1 }}"), 2);
    const sent = fake.requests.find((r) => r.type === "render_template").payload;
    assert.equal(sent.timeout, 3);
    assert.equal(sent.report_errors, true);
    await assert.rejects(() => c.renderTemplateWithTimeout("{% for i in range(100000) %}{% endfor %}", 50), /Exceeded maximum execution time of 10s/);
    await assert.rejects(() => c.renderTemplateWithTimeout("{{ bad }}"), /Template error: TemplateSyntaxError/);
    assert.deepEqual(await c.renderTemplateWithTimeout("{{ undefined_var }}"), { result: "", warnings: ["'undefined_var' is undefined"] });
    assert.ok(!fake.requests.some((r) => r.path === "/api/template"), "must not use POST /api/template");
  } finally {
    await fake.stop();
  }
});
