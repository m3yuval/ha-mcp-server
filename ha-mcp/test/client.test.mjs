// The HA client must refuse anything that could change state, before any network call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HAClient } from "../dist/ha-client.js";

// Port 9 (discard) on localhost: if a request were actually sent it would fail
// with a connection error, not with the "Refusing" message we assert on.
const ha = new HAClient({ baseUrl: "http://127.0.0.1:9", token: "x", timeoutMs: 500 });

test("refuses POST to anything but /api/template", async () => {
  for (const path of ["/api/services/light/turn_on", "/api/states/light.kitchen", "/api/events/foo", "/api/config/core/check_config"]) {
    await assert.rejects(() => ha["request"]("POST", path, {}), /Refusing write request/, path);
  }
});

test("refuses non-API paths", async () => {
  await assert.rejects(() => ha.get("/auth/token"), /Refusing non-API path/);
});

test("refuses websocket commands outside the allowlist", async () => {
  for (const cmd of ["call_service", "config/area_registry/update", "execute_script", "fire_event"]) {
    await assert.rejects(() => ha.wsCommand(cmd), /Refusing websocket command/, cmd);
  }
});
