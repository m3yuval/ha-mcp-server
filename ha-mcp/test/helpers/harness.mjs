// Reusable test harness: a fake Home Assistant (REST + websocket), a fake
// Supervisor, and a helper that starts the real MCP server (dist/index.js)
// against them and connects an MCP client.
//
// Usage:
//   const fake = await startFakeHA({
//     rest: { "GET /api/config": () => ({ version: "x" }),
//             "POST /api/services/light/turn_on": ({ body }) => [] },
//     ws:   { "config_entries/get": () => [] },
//     supervisor: { "GET /addons": () => ({ addons: [] }) },
//   });
//   const srv = await startMcp({ fake, env: { ENABLE_ACTIONS: "true" } });
//   const r = await srv.call("ha_call_service", {...});  // -> { text, isError, json }
//   fake.requests  // every REST/ws/supervisor request the server made, in order
//   await srv.stop(); await fake.stop();
//
// Handlers receive { method, path, query, body } (REST/supervisor) or the
// ws message (ws). Return a value to send it as JSON (supervisor: wrapped in
// {result:"ok",data}), or throw { status, body } / return reply(status, body).
// Unmatched requests get 404 (REST) or a ws error, and are still recorded.

import http from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { READ_ONLY_WS_COMMANDS } from "../../dist/ha-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "../../dist/index.js");

export const HA_TOKEN = "test-ha-token";
export const SUP_TOKEN = "test-supervisor-token";
export const MCP_TOKEN = "test-mcp-token";

export function reply(status, body) {
  return { __reply: true, status, body };
}

function send(res, status, body) {
  if (typeof body === "string") {
    res.writeHead(status, { "content-type": "text/plain" });
    return res.end(body);
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body ?? null));
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Default fake HA: a small but realistic home. Override any route via opts. */
export function defaultRest() {
  const now = new Date().toISOString();
  const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes, last_changed: now, last_updated: now });
  return {
    "GET /api/config": () => ({ version: "2026.9.0", location_name: "Test Home", time_zone: "UTC", components: ["light"], state: "RUNNING" }),
    "GET /api/states": () => [
      st("light.kitchen", "on", { friendly_name: "Kitchen Light" }),
      st("light.bedroom", "off", { friendly_name: "Bedroom Light" }),
      st("lock.front_door", "locked", { friendly_name: "Front Door" }),
      st("sensor.outdoor_temp", "24.5", { friendly_name: "Outdoor Temp", unit_of_measurement: "°C" }),
    ],
    "GET /api/services": () => [{ domain: "light", services: { turn_on: { name: "Turn on", fields: {} }, turn_off: { name: "Turn off", fields: {} } } }],
    "POST /api/template": ({ body }) => {
      // Minimal template support used by the server:
      const t = body?.template ?? "";
      if (t.includes("area_entities") && t.includes("namespace(e=[])")) {
        // blocked-domain target expansion: kitchen area contains the front door lock
        return reply(200, JSON.stringify(t.includes('"kitchen"') ? ["light.kitchen", "lock.front_door"] : []));
      }
      return reply(200, "rendered");
    },
  };
}

export async function startFakeHA(opts = {}) {
  const rest = { ...defaultRest(), ...(opts.rest ?? {}) };
  const wsHandlers = { ...(opts.ws ?? {}) };
  const sup = { ...(opts.supervisor ?? {}) };
  const requests = [];

  const dispatch = async (table, req, res, token, wrapSupervisor) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: "unauthorized" });
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    const key = `${req.method} ${url.pathname}`;
    const entry = { kind: wrapSupervisor ? "supervisor" : "rest", method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body };
    requests.push(entry);
    let handler = table[key];
    if (!handler) {
      // prefix match: "GET /api/states/*"
      const pk = Object.keys(table).find((k) => k.endsWith("*") && key.startsWith(k.slice(0, -1)));
      handler = pk && table[pk];
    }
    if (!handler) return send(res, 404, wrapSupervisor ? { result: "error", message: "not found" } : "404: Not Found");
    try {
      const out = await handler(entry);
      if (out && out.__reply) return send(res, out.status, out.body);
      return send(res, 200, wrapSupervisor ? { result: "ok", data: out ?? {} } : out ?? []);
    } catch (e) {
      return send(res, e?.status ?? 500, e?.body ?? String(e));
    }
  };

  const haServer = http.createServer((req, res) => dispatch(rest, req, res, HA_TOKEN, false));
  const supServer = http.createServer((req, res) => dispatch(sup, req, res, SUP_TOKEN, true));

  const wss = new WebSocketServer({ noServer: true });
  haServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/websocket") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "auth") {
          return ws.send(JSON.stringify({ type: msg.access_token === HA_TOKEN ? "auth_ok" : "auth_invalid" }));
        }
        requests.push({ kind: "ws", type: msg.type, payload: msg, readOnly: READ_ONLY_WS_COMMANDS.has(msg.type) });
        const h = wsHandlers[msg.type];
        if (!h) {
          return ws.send(JSON.stringify({ id: msg.id, type: "result", success: false, error: { code: "unknown_command", message: `Unknown command ${msg.type}` } }));
        }
        try {
          const result = await h(msg);
          ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: result ?? null }));
        } catch (e) {
          ws.send(JSON.stringify({ id: msg.id, type: "result", success: false, error: { code: "error", message: String(e?.message ?? e) } }));
        }
      });
    });
  });

  await new Promise((r) => haServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => supServer.listen(0, "127.0.0.1", r));
  return {
    haUrl: `http://127.0.0.1:${haServer.address().port}`,
    supervisorUrl: `http://127.0.0.1:${supServer.address().port}`,
    requests,
    rest,
    ws: wsHandlers,
    supervisor: sup,
    /** Requests that could change state (anything but GET, template renders and read-only ws). */
    writes() {
      return requests.filter((r) => (r.kind !== "ws" && r.method !== "GET" && r.path !== "/api/template") || (r.kind === "ws" && !r.readOnly));
    },
    async stop() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      haServer.closeAllConnections();
      supServer.closeAllConnections();
      await new Promise((r) => haServer.close(r));
      await new Promise((r) => supServer.close(r));
    },
  };
}

import net from "node:net";

/** Ask the OS for a free port. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Start dist/index.js against a fake HA. Returns helpers to call tools. */
export async function startMcp({ fake, env = {}, withSupervisor = true } = {}) {
  const port = await freePort();
  const logs = [];
  const proc = spawn(process.execPath, [DIST], {
    env: {
      PATH: process.env.PATH,
      HA_URL: fake.haUrl,
      HA_TOKEN,
      ...(withSupervisor ? { SUPERVISOR_URL: fake.supervisorUrl, SUPERVISOR_TOKEN: SUP_TOKEN } : {}),
      MCP_AUTH_TOKEN: MCP_TOKEN,
      PORT: String(port),
      HOST: "127.0.0.1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  let exited = null;
  proc.on("exit", (c) => (exited = c));
  // Wait for /health (works at any LOG_LEVEL). Kill the child if it never comes up.
  const deadline = Date.now() + 10000;
  for (;;) {
    if (exited !== null) throw new Error(`server exited ${exited}:\n` + logs.join(""));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error("server did not start:\n" + logs.join(""));
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );

  return {
    port,
    client,
    logs,
    url: `http://127.0.0.1:${port}`,
    async tools() {
      return (await client.listTools()).tools;
    },
    async toolNames() {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    },
    /** Call a tool. Returns { text, isError, json } (json = parsed text or undefined). */
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content?.[0]?.text ?? "";
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { text, isError: Boolean(r.isError), json };
    },
    async stop() {
      await client.close().catch(() => {});
      proc.kill();
    },
  };
}
