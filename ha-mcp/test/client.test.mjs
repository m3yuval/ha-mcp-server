// The HA client must refuse anything that could change state unless the
// matching capability is enabled — before any network call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HAClient } from "../dist/ha-client.js";

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
