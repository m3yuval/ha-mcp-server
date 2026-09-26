// End-to-end test: starts a fake Home Assistant, starts the MCP server against it,
// and calls every tool through a real MCP client over Streamable HTTP.
// Run with: npm run build && npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketServer } from "ws";

const HA_TOKEN = "test-ha-token";
const MCP_TOKEN = "test-mcp-token";
const MCP_PORT = 39123;
const writeAttempts = [];
const wsCommandsSeen = [];
let calendarsLoaded = true;

const now = new Date().toISOString();
const states = [
  { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen Light" }, last_changed: now, last_updated: now },
  { entity_id: "light.bedroom", state: "off", attributes: { friendly_name: "Bedroom Light" }, last_changed: now, last_updated: now },
  { entity_id: "sensor.outdoor_temp", state: "24.5", attributes: { friendly_name: "Outdoor Temp", unit_of_measurement: "°C", device_class: "temperature" }, last_changed: now, last_updated: now },
];

let haServer;
let mcpProc;

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  haServer = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) return json(res, { message: "unauthorized" }, 401);
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/api/template") {
        const { template } = JSON.parse(body);
        res.writeHead(200, { "content-type": "text/plain" });
        if (template.includes("areas()")) return res.end(JSON.stringify([{ id: "kitchen", name: "Kitchen", entities: ["light.kitchen"] }]));
        if (template.includes("area_name('Kitchen')")) return res.end(JSON.stringify({ id: "kitchen", entities: ["light.kitchen"] }));
        if (template.includes("area_name('Nowhere')")) return res.end(JSON.stringify({ id: null, entities: [] }));
        return res.end("rendered:" + template);
      }
      if (req.method !== "GET") {
        writeAttempts.push(`${req.method} ${url.pathname}`);
        return json(res, { message: "write!" }, 200);
      }
      const p = url.pathname;
      if (p === "/api/config") return json(res, { version: "2026.9.0", location_name: "Home", time_zone: "UTC", components: ["a", "b"], state: "RUNNING" });
      if (p === "/api/states") return json(res, states);
      if (p.startsWith("/api/states/")) {
        const s = states.find((x) => x.entity_id === decodeURIComponent(p.slice(12)));
        return s ? json(res, s) : json(res, { message: "Entity not found." }, 404);
      }
      if (p === "/api/services") return json(res, [{ domain: "light", services: { turn_on: { name: "Turn on", description: "Turn on a light", fields: { brightness: { description: "0-255" } } } } }]);
      if (p.startsWith("/api/history/period/")) return json(res, [[{ entity_id: "sensor.outdoor_temp", state: "23", last_changed: now }, { entity_id: "sensor.outdoor_temp", state: "24.5", last_changed: now }]]);
      if (p.startsWith("/api/logbook/")) return json(res, [{ name: "Kitchen Light", message: "turned on", entity_id: "light.kitchen", when: now }]);
      if (p === "/api/calendars") return calendarsLoaded ? json(res, [{ entity_id: "calendar.family", name: "Family" }]) : json(res, "404: Not Found", 404);
      if (p.startsWith("/api/calendars/")) return json(res, [{ summary: "Dinner", start: { dateTime: now }, end: { dateTime: now } }]);
      json(res, { message: "not found" }, 404);
    });
  });
  // Fake HA websocket API (only what the server uses: auth + system_log/list)
  const wss = new WebSocketServer({ noServer: true });
  haServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/websocket") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: msg.access_token === HA_TOKEN ? "auth_ok" : "auth_invalid" }));
        } else if (msg.type === "system_log/list") {
          ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: [
            { name: "homeassistant.components.zha", message: ["Device offline"], level: "WARNING", source: ["zha.py", 10], timestamp: 1000, first_occurred: 900, count: 3, exception: "" },
            { name: "custom_components.foo", message: ["Setup failed"], level: "ERROR", source: ["foo.py", 5], timestamp: 2000, first_occurred: 2000, count: 1, exception: "Traceback..." },
          ] }));
        } else {
          wsCommandsSeen.push(msg.type);
          ws.send(JSON.stringify({ id: msg.id, type: "result", success: false, error: { message: "unexpected" } }));
        }
      });
    });
  });
  await new Promise((r) => haServer.listen(0, "127.0.0.1", r));
  const haPort = haServer.address().port;

  mcpProc = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, HA_URL: `http://127.0.0.1:${haPort}`, HA_TOKEN, MCP_AUTH_TOKEN: MCP_TOKEN, PORT: String(MCP_PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "inherit", "pipe"],
  });
  await new Promise((resolve, reject) => {
    mcpProc.stderr.on("data", (d) => d.toString().includes("listening") && resolve());
    mcpProc.on("exit", (c) => reject(new Error("server exited " + c)));
  });
});

after(() => {
  mcpProc?.kill();
  haServer?.close();
});

async function connect(url, headers) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

function text(result) {
  return result.content[0].text;
}

test("rejects missing or wrong token", async () => {
  const r1 = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r1.status, 401);
  const r2 = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp/wrong`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r2.status, 401);
});

test("all tools work via bearer auth and none write", async () => {
  const c = await connect(`http://127.0.0.1:${MCP_PORT}/mcp`, { Authorization: `Bearer ${MCP_TOKEN}` });
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "ha_get_calendar_events", "ha_get_config", "ha_get_error_log", "ha_get_history", "ha_get_logbook",
    "ha_get_state", "ha_list_areas", "ha_list_calendars", "ha_list_domains", "ha_list_entities",
    "ha_list_services", "ha_render_template",
  ]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);

  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return text(r);
  };

  assert.match(await call("ha_get_config"), /2026\.9\.0/);
  assert.match(await call("ha_list_domains"), /"light": 2/);
  const lights = JSON.parse(await call("ha_list_entities", { domain: "light", state: "on" }));
  assert.equal(lights.total, 1);
  assert.equal(lights.entities[0].entity_id, "light.kitchen");
  const byArea = JSON.parse(await call("ha_list_entities", { area: "Kitchen" }));
  assert.deepEqual(byArea.entities.map((e) => e.entity_id), ["light.kitchen"]);
  assert.match(await call("ha_get_state", { entity_ids: ["sensor.outdoor_temp"] }), /24\.5/);
  assert.match(await call("ha_list_areas"), /Kitchen/);
  assert.match(await call("ha_list_services"), /turn_on/);
  assert.match(await call("ha_list_services", { domain: "light" }), /brightness/);
  assert.match(await call("ha_get_history", { entity_ids: ["sensor.outdoor_temp"] }), /"changes": 2/);
  assert.match(await call("ha_get_logbook"), /turned on/);
  assert.match(await call("ha_list_calendars"), /calendar\.family/);
  assert.match(await call("ha_get_calendar_events", { entity_id: "calendar.family" }), /Dinner/);
  const log = JSON.parse(await call("ha_get_error_log"));
  assert.equal(log.total, 2);
  assert.equal(log.entries[0].level, "ERROR", "newest first");
  assert.equal(log.entries[0].exception, undefined, "no stack traces by default");
  const warn = JSON.parse(await call("ha_get_error_log", { level: "WARNING" }));
  assert.equal(warn.total, 1);
  assert.equal(warn.entries[0].logger, "homeassistant.components.zha");
  const withExc = JSON.parse(await call("ha_get_error_log", { search: "foo", include_exceptions: true }));
  assert.equal(withExc.entries[0].exception, "Traceback...");

  const unknownArea = await c.callTool({ name: "ha_list_entities", arguments: { area: "Nowhere" } });
  assert.ok(unknownArea.isError);
  assert.match(text(unknownArea), /Area 'Nowhere' not found/);

  calendarsLoaded = false;
  assert.match(await call("ha_list_calendars"), /No calendar integration/);
  calendarsLoaded = true;
  assert.match(await call("ha_render_template", { template: "{{ 1 }}" }), /rendered/);

  const missing = await c.callTool({ name: "ha_get_state", arguments: { entity_ids: ["light.nope"] } });
  assert.match(text(missing), /404/);

  assert.deepEqual(writeAttempts, [], "server must never send write requests");
  assert.deepEqual(wsCommandsSeen, [], "server must only send allowlisted websocket commands");
  await c.close();
});

test("path-token auth works (for claude.ai connectors)", async () => {
  const c = await connect(`http://127.0.0.1:${MCP_PORT}/mcp/${MCP_TOKEN}`, {});
  const { tools } = await c.listTools();
  assert.ok(tools.length > 0);
  await c.close();
});
