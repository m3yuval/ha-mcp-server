// Action tools (capability: actions): registration, request shapes, validation,
// blocked domains and response handling. Runs the real server against a fake HA.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeHA, startMcp, reply } from "./helpers/harness.mjs";

const now = new Date().toISOString();
const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes, last_changed: now, last_updated: now });

const STATES = Object.fromEntries(
  [
    st("light.kitchen", "on", { friendly_name: "Kitchen Light", brightness: 128 }),
    st("light.bedroom", "off", { friendly_name: "Bedroom Light" }),
    st("switch.fan_plug", "off"),
    st("group.downstairs", "off"),
    st("group.doors", "off", { entity_id: ["lock.front_door"] }),
    st("lock.front_door", "locked", { friendly_name: "Front Door" }),
    st("climate.living_room", "heat", {
      hvac_modes: ["off", "heat", "cool", "heat_cool"],
      preset_modes: ["eco", "comfort"],
      fan_modes: ["auto", "low", "high"],
      temperature: 21,
    }),
    st("cover.blinds", "open", { current_position: 100 }),
    st("valve.garden", "closed"),
    st("media_player.speaker", "playing", { volume_level: 0.5, source_list: ["Radio", "Spotify"] }),
    st("input_number.target", "20", { min: 10, max: 30 }),
    st("number.dryer_minutes", "30", { min: 0, max: 120 }),
    st("input_select.mode", "Home", { options: ["Home", "Away", "Night"] }),
    st("input_boolean.guest", "off"),
    st("input_datetime.alarm", "07:00:00", { has_date: false, has_time: true }),
    st("script.good_night", "off"),
    st("scene.movie", "2026-01-01T00:00:00+00:00"),
    st("automation.porch", "on", { last_triggered: null }),
    st("button.restart_router", "unknown"),
    st("input_button.doorbell", "unknown"),
    st("notify.living_room_tv", "unknown"),
    st("vacuum.robo", "docked", { fan_speed_list: ["quiet", "max"] }),
    st("lawn_mower.mowy", "docked"),
    st("todo.shopping_list", "2"),
    st("weather.home", "sunny"),
    st("sensor.temp", "21"),
  ].map((s) => [s.entity_id, s]),
);

const svc = (...names) => Object.fromEntries(names.map((n) => [n, { name: n, fields: {} }]));
const SERVICES = [
  { domain: "homeassistant", services: svc("turn_on", "turn_off", "toggle", "update_entity") },
  { domain: "light", services: svc("turn_on", "turn_off", "toggle") },
  { domain: "switch", services: svc("turn_on", "turn_off", "toggle") },
  { domain: "lock", services: svc("lock", "unlock", "open") },
  { domain: "climate", services: svc("set_hvac_mode", "set_temperature", "set_preset_mode", "set_fan_mode", "set_swing_mode", "set_humidity", "turn_on", "turn_off") },
  { domain: "cover", services: svc("open_cover", "close_cover", "stop_cover", "toggle", "set_cover_position", "set_cover_tilt_position") },
  { domain: "valve", services: svc("open_valve", "close_valve", "toggle", "set_valve_position") },
  { domain: "media_player", services: svc("media_play", "media_pause", "volume_set", "volume_mute", "select_source", "play_media", "turn_on", "turn_off") },
  { domain: "input_number", services: svc("set_value") },
  { domain: "input_select", services: svc("select_option") },
  { domain: "input_boolean", services: svc("turn_on", "turn_off", "toggle") },
  { domain: "input_datetime", services: svc("set_datetime") },
  { domain: "number", services: svc("set_value") },
  { domain: "script", services: svc("turn_on", "turn_off", "toggle", "good_night") },
  { domain: "scene", services: svc("turn_on", "apply", "create") },
  { domain: "group", services: svc("set", "remove") },
  { domain: "conversation", services: svc("process") },
  { domain: "hassio", services: svc("host_shutdown", "addon_stop") },
  { domain: "automation", services: svc("trigger", "turn_on", "turn_off", "toggle") },
  { domain: "button", services: svc("press") },
  { domain: "input_button", services: svc("press") },
  { domain: "notify", services: svc("send_message", "mobile_app_phone", "persistent_notification") },
  { domain: "persistent_notification", services: svc("create", "dismiss") },
  { domain: "vacuum", services: svc("start", "pause", "stop", "return_to_base", "locate", "set_fan_speed") },
  { domain: "lawn_mower", services: svc("start_mowing", "pause", "dock") },
  { domain: "todo", services: { ...svc("add_item", "update_item", "remove_item", "remove_completed_items"), get_items: { fields: {}, response: { optional: false } } } },
  { domain: "weather", services: { get_forecasts: { fields: {}, response: { optional: false } } } },
];

let exposed = {};
const fake = await startFakeHA({
  rest: {
    "GET /api/services": () => SERVICES,
    "GET /api/states/*": ({ path }) => {
      const id = decodeURIComponent(path.slice("/api/states/".length));
      return STATES[id] ?? reply(404, { message: "Entity not found." });
    },
    "POST /api/services/*": ({ path, query, body }) => {
      const [, , , domain, service] = path.split("/");
      const changed = [].concat(body?.entity_id ?? []).map((id) => STATES[id]).filter(Boolean);
      if (!("return_response" in query)) return changed;
      let service_response = {};
      if (domain === "weather") service_response = { "weather.home": { forecast: [{ condition: "sunny", temperature: 25 }] } };
      if (domain === "todo") service_response = { "todo.shopping_list": { items: [{ summary: "Milk", uid: "1", status: "needs_action" }] } };
      if (domain === "script") service_response = { result: "done", service };
      return { changed_states: changed, service_response };
    },
    "POST /api/events/*": ({ path }) => ({ message: `Event ${path.split("/").pop()} fired.` }),
    // Blocked-domain target expansion (see HAClient.assertNotBlocked).
    "POST /api/template": ({ body }) => {
      const t = body?.template ?? "";
      if (!t.includes("namespace(e=[])")) return reply(200, "rendered");
      const out = [];
      if (t.includes('"kitchen"')) out.push("light.kitchen", "lock.front_door");
      // label -> labelled device -> its lock (only if the template follows label_devices)
      if (t.includes('"security"') && t.includes("label_devices(l)")) out.push("lock.front_door");
      if (t.includes('"group.doors"') && t.includes("expand(")) out.push("group.doors", "lock.front_door");
      return reply(200, JSON.stringify(out));
    },
    "POST /api/conversation/process": ({ body }) => ({
      response: {
        response_type: "action_done",
        language: "en",
        data: { success: [{ id: "light.kitchen", type: "entity", name: "Kitchen Light" }], failed: [] },
        speech: { plain: { speech: `Done: ${body.text}` } },
      },
      conversation_id: "abc",
      continue_conversation: false,
    }),
  },
  ws: {
    "homeassistant/expose_entity/list": () => ({ exposed_entities: exposed }),
    render_template: (msg) =>
      msg.template.includes("range(")
        ? { __error: { code: "template_error", message: `Exceeded maximum execution time of ${msg.timeout}s` } }
        : { __events: [{ result: "rendered-ws", listeners: {} }] },
  },
});

let srv;
before(async () => {
  srv = await startMcp({ fake, env: { ENABLE_ACTIONS: "true", BLOCKED_DOMAINS: "lock" } });
});
after(async () => {
  await srv?.stop();
  await fake.stop();
});
beforeEach(() => {
  fake.requests.length = 0;
  exposed = {};
});

/** Service-call requests sent to HA. */
const serviceCalls = () => fake.requests.filter((r) => r.kind === "rest" && r.method === "POST" && r.path.startsWith("/api/services/"));

/** Call a tool; returns { isError, text, json } whether the SDK reports schema errors as results or throws. */
async function call(name, args) {
  try {
    return await srv.call(name, args);
  } catch (e) {
    return { isError: true, text: String(e?.message ?? e), json: undefined };
  }
}

async function ok(name, args) {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.text}`);
  return r.json;
}

const ACTION_TOOLS = {
  ha_call_service: "destructive",
  ha_turn_on: "write",
  ha_turn_off: "write",
  ha_toggle: "write",
  ha_set_climate: "write",
  ha_control_cover: "write",
  ha_control_media_player: "write",
  ha_set_value: "write",
  ha_run_script: "write",
  ha_activate_scene: "write",
  ha_trigger_automation: "write",
  ha_set_automation_enabled: "write",
  ha_press_button: "write",
  ha_send_notification: "write",
  ha_vacuum: "write",
  ha_manage_todo: "write",
  ha_conversation: "destructive",
  ha_fire_event: "destructive",
};

// ------------------------------------------------------------ registration

test("action tools are not registered when ENABLE_ACTIONS is unset", async () => {
  const ro = await startMcp({ fake });
  try {
    const names = await ro.toolNames();
    for (const n of Object.keys(ACTION_TOOLS)) assert.ok(!names.includes(n), `${n} should not be registered`);
  } finally {
    await ro.stop();
  }
});

test("all action tools registered with WRITE / DESTRUCTIVE annotations and descriptions", async () => {
  const tools = await srv.tools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const [name, kind] of Object.entries(ACTION_TOOLS)) {
    const t = byName[name];
    assert.ok(t, `${name} missing`);
    assert.equal(t.annotations?.readOnlyHint, false, name);
    assert.equal(t.annotations?.destructiveHint, kind === "destructive", name);
    assert.ok(t.description.length > 80, `${name} needs a useful description`);
  }
});

// ---------------------------------------------------------- ha_call_service

test("ha_call_service sends target + data and returns new states", async () => {
  const r = await ok("ha_call_service", {
    domain: "light",
    service: "turn_on",
    target: { entity_id: ["light.kitchen", "light.bedroom"] },
    data: { brightness_pct: 40 },
  });
  const calls = serviceCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/services/light/turn_on");
  assert.deepEqual(calls[0].body, { brightness_pct: 40, entity_id: ["light.kitchen", "light.bedroom"] });
  assert.ok(!("return_response" in calls[0].query));
  assert.deepEqual(r.actions, ["light.turn_on"]);
  assert.equal(r.states[0].entity_id, "light.kitchen");
  assert.equal(r.states[0].brightness_pct, 50);
});

test("ha_call_service with return_response passes ?return_response and returns service_response", async () => {
  const r = await ok("ha_call_service", {
    domain: "script",
    service: "good_night",
    return_response: true,
  });
  const [c] = serviceCalls();
  assert.equal(c.path, "/api/services/script/good_night");
  assert.ok("return_response" in c.query);
  assert.deepEqual(r.service_response, { result: "done", service: "good_night" });
});

test("ha_call_service enables return_response automatically for actions that require it", async () => {
  const r = await ok("ha_call_service", {
    domain: "weather",
    service: "get_forecasts",
    target: { entity_id: "weather.home" },
    data: { type: "daily" },
  });
  const [c] = serviceCalls();
  assert.ok("return_response" in c.query);
  assert.deepEqual(c.body, { type: "daily", entity_id: "weather.home" });
  assert.equal(r.service_response["weather.home"].forecast[0].condition, "sunny");
  assert.match(r.note, /automatically/);
});

test("ha_call_service: unknown action → helpful error with close matches, nothing sent", async () => {
  const r = await call("ha_call_service", { domain: "light", service: "turn_onn", target: { entity_id: "light.kitchen" } });
  assert.ok(r.isError);
  assert.match(r.text, /Unknown action 'light\.turn_onn'/);
  assert.match(r.text, /Did you mean: .*light\.turn_on/);
  assert.equal(serviceCalls().length, 0);

  const r2 = await call("ha_call_service", { domain: "lights", service: "turn_on" });
  assert.ok(r2.isError);
  assert.match(r2.text, /no 'lights' domain/);
  assert.match(r2.text, /light\.turn_on/);
  assert.equal(serviceCalls().length, 0);
});

test("ha_call_service: invalid or unknown entity ids are rejected before sending", async () => {
  const bad = await call("ha_call_service", { domain: "light", service: "turn_on", target: { entity_id: "Kitchen Light" } });
  assert.ok(bad.isError);
  assert.match(bad.text, /Invalid entity id/);
  const missing = await call("ha_call_service", { domain: "light", service: "turn_on", target: { entity_id: "light.nope" } });
  assert.ok(missing.isError);
  assert.match(missing.text, /Entity not found: light\.nope/);
  assert.equal(serviceCalls().length, 0);
});

test("ha_call_service: blocked domain refused directly and via entity/area target", async () => {
  const direct = await call("ha_call_service", { domain: "lock", service: "unlock", target: { entity_id: "lock.front_door" } });
  assert.ok(direct.isError);
  assert.match(direct.text, /blocked/);
  const viaEntity = await call("ha_call_service", { domain: "homeassistant", service: "turn_off", target: { entity_id: "lock.front_door" } });
  assert.ok(viaEntity.isError);
  assert.match(viaEntity.text, /blocked entities \(lock\.front_door\)/);
  const viaArea = await call("ha_call_service", { domain: "homeassistant", service: "turn_off", target: { area_id: "kitchen" } });
  assert.ok(viaArea.isError);
  assert.match(viaArea.text, /lock\.front_door/);
  assert.equal(serviceCalls().length, 0);
});

// ------------------------------------------------------- on / off / toggle

test("ha_turn_on routes each entity to its own domain and passes light options", async () => {
  const r = await ok("ha_turn_on", { entity_ids: ["light.kitchen", "switch.fan_plug"], brightness_pct: 30, transition: 2 });
  const calls = serviceCalls();
  assert.deepEqual(
    calls.map((c) => [c.path, c.body]),
    [
      ["/api/services/light/turn_on", { brightness_pct: 30, transition: 2, entity_id: ["light.kitchen"] }],
      ["/api/services/switch/turn_on", { brightness_pct: 30, transition: 2, entity_id: ["switch.fan_plug"] }],
    ],
  );
  assert.deepEqual(r.states.map((s) => s.entity_id), ["light.kitchen", "switch.fan_plug"]);
});

test("ha_turn_off maps covers to close_cover, groups to homeassistant.turn_off, accepts a single string", async () => {
  await ok("ha_turn_off", { entity_ids: "cover.blinds" });
  await ok("ha_turn_off", { entity_ids: "group.downstairs" });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/cover/close_cover", { entity_id: ["cover.blinds"] }],
      ["/api/services/homeassistant/turn_off", { entity_id: ["group.downstairs"] }],
    ],
  );
});

test("ha_toggle with area + domain targets that domain in the area", async () => {
  await ok("ha_toggle", { area_id: "living_room", domain: "light" });
  const [c] = serviceCalls();
  assert.equal(c.path, "/api/services/light/toggle");
  assert.deepEqual(c.body, { area_id: "living_room" });
});

test("ha_turn_off on an area containing a blocked lock is refused and no service request reaches HA", async () => {
  const r = await call("ha_turn_off", { area_id: "kitchen" });
  assert.ok(r.isError);
  assert.match(r.text, /blocked entities \(lock\.front_door\)/);
  assert.equal(serviceCalls().length, 0);
  assert.deepEqual(fake.writes(), []);
  // Same when the area is combined with an allowed entity: nothing partial is sent.
  const r2 = await call("ha_turn_off", { entity_ids: "light.bedroom", area_id: "kitchen", domain: "light" });
  assert.ok(r2.isError);
  assert.equal(serviceCalls().length, 0);
});

test("ha_turn_on refuses locks and unknown entities; data to an area needs a domain", async () => {
  const lock = await call("ha_turn_on", { entity_ids: "lock.front_door" });
  assert.ok(lock.isError);
  assert.match(lock.text, /ha_call_service/);
  const missing = await call("ha_turn_on", { entity_ids: "light.ghost" });
  assert.ok(missing.isError);
  assert.match(missing.text, /Entity not found/);
  const badId = await call("ha_turn_on", { entity_ids: "not an id" });
  assert.ok(badId.isError);
  const noDomain = await call("ha_turn_on", { area_id: "office", brightness_pct: 50 });
  assert.ok(noDomain.isError);
  assert.match(noDomain.text, /set 'domain'/);
  const none = await call("ha_turn_on", {});
  assert.ok(none.isError);
  assert.equal(serviceCalls().length, 0);
});

// ---------------------------------------------------------------- climate

test("ha_set_climate: temperature with mode goes in set_temperature; preset separately", async () => {
  await ok("ha_set_climate", { entity_ids: "climate.living_room", hvac_mode: "cool", temperature: 23, preset_mode: "eco" });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/climate/set_preset_mode", { preset_mode: "eco", entity_id: ["climate.living_room"] }],
      ["/api/services/climate/set_temperature", { temperature: 23, hvac_mode: "cool", entity_id: ["climate.living_room"] }],
    ],
  );
});

test("ha_set_climate: hvac_mode only → set_hvac_mode; unsupported values and wrong domain rejected", async () => {
  await ok("ha_set_climate", { entity_ids: ["climate.living_room"], hvac_mode: "off" });
  assert.equal(serviceCalls()[0].path, "/api/services/climate/set_hvac_mode");
  fake.requests.length = 0;
  const bad = await call("ha_set_climate", { entity_ids: "climate.living_room", fan_mode: "turbo" });
  assert.ok(bad.isError);
  assert.match(bad.text, /Supported: auto, low, high/);
  const wrongDomain = await call("ha_set_climate", { entity_ids: "light.kitchen", hvac_mode: "heat" });
  assert.ok(wrongDomain.isError);
  assert.match(wrongDomain.text, /climate/);
  assert.equal(serviceCalls().length, 0);
});

// ----------------------------------------------------------------- covers

test("ha_control_cover: set_position on cover, open on valve, area close", async () => {
  await ok("ha_control_cover", { entity_ids: "cover.blinds", action: "set_position", position: 30 });
  await ok("ha_control_cover", { entity_ids: "valve.garden", action: "open" });
  await ok("ha_control_cover", { area_id: "bedroom", action: "close" });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/cover/set_cover_position", { position: 30, entity_id: ["cover.blinds"] }],
      ["/api/services/valve/open_valve", { entity_id: ["valve.garden"] }],
      ["/api/services/cover/close_cover", { area_id: "bedroom" }],
    ],
  );
  const missing = await call("ha_control_cover", { entity_ids: "cover.blinds", action: "set_position" });
  assert.ok(missing.isError);
  const tilt = await call("ha_control_cover", { entity_ids: "valve.garden", action: "open_tilt" });
  assert.ok(tilt.isError);
});

// ---------------------------------------------------------- media players

test("ha_control_media_player: volume, mute, source validation, play_media", async () => {
  await ok("ha_control_media_player", { entity_ids: "media_player.speaker", action: "volume_set", volume_level: 0.3 });
  await ok("ha_control_media_player", { entity_ids: "media_player.speaker", action: "mute" });
  await ok("ha_control_media_player", {
    entity_ids: "media_player.speaker",
    action: "play_media",
    media_content_id: "http://x/stream.mp3",
    media_content_type: "music",
  });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/media_player/volume_set", { volume_level: 0.3, entity_id: ["media_player.speaker"] }],
      ["/api/services/media_player/volume_mute", { is_volume_muted: true, entity_id: ["media_player.speaker"] }],
      ["/api/services/media_player/play_media", { media_content_id: "http://x/stream.mp3", media_content_type: "music", entity_id: ["media_player.speaker"] }],
    ],
  );
  fake.requests.length = 0;
  const src = await call("ha_control_media_player", { entity_ids: "media_player.speaker", action: "select_source", source: "TV" });
  assert.ok(src.isError);
  assert.match(src.text, /Available: Radio, Spotify/);
  const vol = await call("ha_control_media_player", { entity_ids: "media_player.speaker", action: "volume_set", volume_level: 30 });
  assert.ok(vol.isError);
  assert.equal(serviceCalls().length, 0);
});

// -------------------------------------------------------------- set value

test("ha_set_value picks the right action per domain", async () => {
  await ok("ha_set_value", { entity_id: "input_number.target", value: 22.5 });
  await ok("ha_set_value", { entity_id: "number.dryer_minutes", value: "45" });
  await ok("ha_set_value", { entity_id: "input_select.mode", value: "Away" });
  await ok("ha_set_value", { entity_id: "input_boolean.guest", value: true });
  await ok("ha_set_value", { entity_id: "input_datetime.alarm", value: "06:45" });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/input_number/set_value", { value: 22.5, entity_id: "input_number.target" }],
      ["/api/services/number/set_value", { value: 45, entity_id: "number.dryer_minutes" }],
      ["/api/services/input_select/select_option", { option: "Away", entity_id: "input_select.mode" }],
      ["/api/services/input_boolean/turn_on", { entity_id: "input_boolean.guest" }],
      ["/api/services/input_datetime/set_datetime", { time: "06:45", entity_id: "input_datetime.alarm" }],
    ],
  );
});

test("ha_set_value validates range, options and domain", async () => {
  const range = await call("ha_set_value", { entity_id: "input_number.target", value: 99 });
  assert.ok(range.isError);
  assert.match(range.text, /out of range/);
  const opt = await call("ha_set_value", { entity_id: "input_select.mode", value: "Vacation" });
  assert.ok(opt.isError);
  assert.match(opt.text, /Options: Home, Away, Night/);
  const dom = await call("ha_set_value", { entity_id: "sensor.temp", value: 5 });
  assert.ok(dom.isError);
  assert.equal(serviceCalls().length, 0);
});

// ---------------------------------------------------- scripts / scenes / etc

test("ha_run_script: fire-and-forget uses script.turn_on with variables; wait uses script.<id> with return_response", async () => {
  await ok("ha_run_script", { entity_id: "script.good_night", variables: { level: 2 } });
  const r = await ok("ha_run_script", { entity_id: "script.good_night", variables: { level: 2 }, wait_for_response: true });
  const calls = serviceCalls();
  assert.equal(calls[0].path, "/api/services/script/turn_on");
  assert.deepEqual(calls[0].body, { variables: { level: 2 }, entity_id: "script.good_night" });
  assert.equal(calls[1].path, "/api/services/script/good_night");
  assert.ok("return_response" in calls[1].query);
  assert.deepEqual(calls[1].body, { level: 2 });
  assert.equal(r.service_response.result, "done");
});

test("scene, automation trigger/enable, buttons", async () => {
  await ok("ha_activate_scene", { entity_ids: "scene.movie", transition: 2 });
  await ok("ha_trigger_automation", { entity_ids: "automation.porch" });
  await ok("ha_set_automation_enabled", { entity_ids: "automation.porch", enabled: false });
  await ok("ha_set_automation_enabled", { entity_ids: "automation.porch", enabled: true });
  await ok("ha_press_button", { entity_ids: ["button.restart_router", "input_button.doorbell"] });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/scene/turn_on", { transition: 2, entity_id: ["scene.movie"] }],
      ["/api/services/automation/trigger", { skip_condition: true, entity_id: ["automation.porch"] }],
      ["/api/services/automation/turn_off", { stop_actions: true, entity_id: ["automation.porch"] }],
      ["/api/services/automation/turn_on", { entity_id: ["automation.porch"] }],
      ["/api/services/button/press", { entity_id: ["button.restart_router"] }],
      ["/api/services/input_button/press", { entity_id: ["input_button.doorbell"] }],
    ],
  );
  const wrong = await call("ha_activate_scene", { entity_ids: "script.good_night" });
  assert.ok(wrong.isError);
});

// ---------------------------------------------------------- notifications

test("ha_send_notification: legacy service, notify entity, persistent; errors list options", async () => {
  await ok("ha_send_notification", { service: "notify.mobile_app_phone", title: "Hi", message: "Door open", data: { priority: "high" } });
  await ok("ha_send_notification", { entity_id: "notify.living_room_tv", message: "Dinner" });
  await ok("ha_send_notification", { persistent: true, message: "Check the filter" });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/notify/mobile_app_phone", { message: "Door open", title: "Hi", data: { priority: "high" } }],
      ["/api/services/notify/send_message", { message: "Dinner", entity_id: "notify.living_room_tv" }],
      ["/api/services/persistent_notification/create", { message: "Check the filter" }],
    ],
  );
  fake.requests.length = 0;
  const none = await call("ha_send_notification", { message: "x" });
  assert.ok(none.isError);
  assert.match(none.text, /mobile_app_phone/);
  const unknown = await call("ha_send_notification", { service: "mobile_app_tablet", message: "x" });
  assert.ok(unknown.isError);
  assert.match(unknown.text, /Unknown action 'notify\.mobile_app_tablet'.*mobile_app_phone/);
  assert.equal(serviceCalls().length, 0);
});

// ---------------------------------------------------------------- vacuum

test("ha_vacuum: vacuum + lawn mower mapping and fan speed validation", async () => {
  await ok("ha_vacuum", { entity_ids: ["vacuum.robo", "lawn_mower.mowy"], action: "return_to_base" });
  await ok("ha_vacuum", { entity_ids: "vacuum.robo", action: "set_fan_speed", fan_speed: "max" });
  assert.deepEqual(
    serviceCalls().map((c) => [c.path, c.body]),
    [
      ["/api/services/vacuum/return_to_base", { entity_id: ["vacuum.robo"] }],
      ["/api/services/lawn_mower/dock", { entity_id: ["lawn_mower.mowy"] }],
      ["/api/services/vacuum/set_fan_speed", { fan_speed: "max", entity_id: ["vacuum.robo"] }],
    ],
  );
  const bad = await call("ha_vacuum", { entity_ids: "vacuum.robo", action: "set_fan_speed", fan_speed: "turbo" });
  assert.ok(bad.isError);
  const mower = await call("ha_vacuum", { entity_ids: "lawn_mower.mowy", action: "locate" });
  assert.ok(mower.isError);
});

// ------------------------------------------------------------------ todo

test("ha_manage_todo: get_items with return_response, add/update/remove", async () => {
  const items = await ok("ha_manage_todo", { entity_id: "todo.shopping_list", action: "get_items", status_filter: ["needs_action"] });
  assert.equal(items.count, 1);
  assert.equal(items.items[0].summary, "Milk");
  await ok("ha_manage_todo", { entity_id: "todo.shopping_list", action: "add_item", item: "Eggs", due_date: "2026-10-01" });
  await ok("ha_manage_todo", { entity_id: "todo.shopping_list", action: "update_item", item: "Milk", status: "completed" });
  await ok("ha_manage_todo", { entity_id: "todo.shopping_list", action: "remove_item", item: ["Eggs", "Milk"] });
  const calls = serviceCalls();
  assert.ok("return_response" in calls[0].query);
  assert.deepEqual(
    calls.map((c) => [c.path, c.body]),
    [
      ["/api/services/todo/get_items", { status: ["needs_action"], entity_id: "todo.shopping_list" }],
      ["/api/services/todo/add_item", { item: "Eggs", due_date: "2026-10-01", entity_id: "todo.shopping_list" }],
      ["/api/services/todo/update_item", { item: "Milk", status: "completed", entity_id: "todo.shopping_list" }],
      ["/api/services/todo/remove_item", { item: ["Eggs", "Milk"], entity_id: "todo.shopping_list" }],
    ],
  );
  const noItem = await call("ha_manage_todo", { entity_id: "todo.shopping_list", action: "add_item" });
  assert.ok(noItem.isError);
});

// ---------------------------------------------------------- conversation

test("ha_conversation posts to /api/conversation/process and returns the speech", async () => {
  exposed = { "light.kitchen": { conversation: true }, "lock.front_door": { conversation: false } };
  const r = await ok("ha_conversation", { text: "turn on the kitchen lights", language: "en" });
  const req = fake.requests.find((x) => x.path === "/api/conversation/process");
  assert.deepEqual(req.body, { text: "turn on the kitchen lights", language: "en" });
  assert.equal(r.speech, "Done: turn on the kitchen lights");
  assert.equal(r.conversation_id, "abc");
});

test("ha_conversation is refused when Assist can reach a blocked domain", async () => {
  exposed = { "light.kitchen": { conversation: true }, "lock.front_door": { conversation: true } };
  const r = await call("ha_conversation", { text: "unlock the front door" });
  assert.ok(r.isError);
  assert.match(r.text, /lock\.front_door/);
  assert.ok(!fake.requests.some((x) => x.path === "/api/conversation/process"));
});

// ----------------------------------------------------------------- events

test("ha_fire_event posts event data; system events and blocked entities refused", async () => {
  const r = await ok("ha_fire_event", { event_type: "my_event", event_data: { room: "kitchen" } });
  const req = fake.requests.find((x) => x.path === "/api/events/my_event");
  assert.equal(req.method, "POST");
  assert.deepEqual(req.body, { room: "kitchen" });
  assert.equal(r.event_type, "my_event");
  fake.requests.length = 0;
  const sys = await call("ha_fire_event", { event_type: "homeassistant_stop" });
  assert.ok(sys.isError);
  const blocked = await call("ha_fire_event", { event_type: "my_event", event_data: { entity_id: "lock.front_door" } });
  assert.ok(blocked.isError);
  const badType = await call("ha_fire_event", { event_type: "bad type/../x" });
  assert.ok(badType.isError);
  assert.deepEqual(fake.writes(), []);
});

// ------------------------------------------------------ security findings

test("H1: ha_call_service refuses system-level actions and names the switch; nothing sent", async () => {
  for (const [domain, service, sw] of [
    ["hassio", "host_shutdown", "enable_management"],
    ["hassio", "addon_stop", "enable_management"],
    ["homeassistant", "restart", "enable_management"],
    ["update", "install", "enable_management"],
    ["homeassistant", "reload_all", "enable_config_files"],
  ]) {
    const r = await call("ha_call_service", { domain, service, data: { addon: "self" } });
    assert.ok(r.isError, `${domain}.${service}`);
    assert.match(r.text, new RegExp(`system-level action.*${sw}`), `${domain}.${service}`);
  }
  assert.deepEqual(fake.writes(), []);
  // Ordinary homeassistant.* device control still works
  await ok("ha_call_service", { domain: "homeassistant", service: "update_entity", target: { entity_id: "sensor.temp" } });
});

test("H2: target keys inside data are refused; comma/uuid entity values can't sneak past blocked_domains", async () => {
  for (const key of ["entity_id", "device_id", "area_id", "floor_id", "label_id"]) {
    const r = await call("ha_call_service", { domain: "light", service: "turn_on", data: { [key]: "lock.front_door" } });
    assert.ok(r.isError, key);
    assert.match(r.text, new RegExp(`Put ${key} in 'target'`));
  }
  const sw = await call("ha_turn_on", { entity_ids: "light.kitchen", data: { entity_id: "light.kitchen,lock.front_door" } });
  assert.ok(sw.isError);
  assert.match(sw.text, /Put entity_id in 'target'/);
  const comma = await call("ha_call_service", { domain: "homeassistant", service: "turn_off", target: { entity_id: "light.kitchen,lock.front_door" } });
  assert.ok(comma.isError);
  const uuid = await call("ha_call_service", { domain: "homeassistant", service: "turn_off", target: { entity_id: "0123456789abcdef0123456789abcdef" } });
  assert.ok(uuid.isError);
  assert.deepEqual(fake.writes(), []);
});

test("H3: a label that reaches a lock through a labelled device is refused", async () => {
  const r = await call("ha_turn_off", { label_id: "security" });
  assert.ok(r.isError);
  assert.match(r.text, /blocked entities \(lock\.front_door\)/);
  const tpl = fake.requests.find((x) => x.path === "/api/template").body.template;
  for (const fn of ["label_entities(l)", "label_devices(l)", "label_areas(l)", "device_entities(dv)", "area_entities(a)"]) assert.ok(tpl.includes(fn), fn);
  assert.deepEqual(fake.writes(), []);
});

test("H4: groups are expanded; scene.apply/create, group.set, conversation.process and blocked mentions refused", async () => {
  const grp = await call("ha_turn_off", { entity_ids: "group.doors" });
  assert.ok(grp.isError);
  assert.match(grp.text, /lock\.front_door/);
  for (const service of ["apply", "create"]) {
    const r = await call("ha_call_service", { domain: "scene", service, data: { entities: { "light.kitchen": "on" } } });
    assert.ok(r.isError);
    assert.match(r.text, new RegExp(`scene\\.${service} while blocked_domains`));
  }
  const gs = await call("ha_call_service", { domain: "group", service: "set", data: { object_id: "x", entities: ["light.kitchen"] } });
  assert.ok(gs.isError);
  exposed = { "lock.front_door": { conversation: true } };
  const conv = await call("ha_call_service", { domain: "conversation", service: "process", data: { text: "unlock the door" } });
  assert.ok(conv.isError);
  assert.match(conv.text, /Assist can control/);
  const note = await call("ha_send_notification", { persistent: true, message: "state of lock.front_door" });
  assert.ok(note.isError);
  assert.match(note.text, /mentions blocked entities/);
  const scriptVars = await call("ha_run_script", { entity_id: "script.good_night", variables: { target: "lock.front_door" } });
  assert.ok(scriptVars.isError);
  assert.deepEqual(fake.writes(), []);
  // Multi-call plans are all checked before the first call is sent
  const mixed = await call("ha_turn_off", { entity_ids: ["light.kitchen", "group.doors"] });
  assert.ok(mixed.isError);
  assert.equal(serviceCalls().length, 0);
});

test("M4: ha_render_template renders over the websocket with a timeout, never POST /api/template", async () => {
  const r = await srv.call("ha_render_template", { template: "{{ 1 }}" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /rendered-ws/);
  const req = fake.requests.find((x) => x.type === "render_template");
  assert.equal(req.payload.timeout, 3);
  assert.equal(req.payload.report_errors, true);
  const slow = await srv.call("ha_render_template", {
    template: "{% for i in range(100000) %}{% for j in range(100000) %}{% endfor %}{% endfor %}",
    timeout_seconds: 5,
  });
  assert.ok(slow.isError);
  assert.match(slow.text, /Exceeded maximum execution time of 5s/);
  const tooLong = await call("ha_render_template", { template: "{{ 1 }}", timeout_seconds: 60 });
  assert.ok(tooLong.isError);
  assert.ok(!fake.requests.some((x) => x.path === "/api/template"));
});
