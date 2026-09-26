// Foundation: capability gating of tool registration, per-request logging.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeHA, startMcp, MCP_TOKEN } from "./helpers/harness.mjs";

const fake = await startFakeHA();
after(() => fake.stop());

const READ_TOOLS = [
  "ha_get_calendar_events", "ha_get_config", "ha_get_error_log", "ha_get_history", "ha_get_logbook",
  "ha_get_state", "ha_list_areas", "ha_list_calendars", "ha_list_domains", "ha_list_entities",
  "ha_list_services", "ha_render_template",
];

test("default config: only read tools, all marked read-only, no writes sent", async () => {
  const srv = await startMcp({ fake });
  try {
    const tools = await srv.tools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READ_TOOLS);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    const r = await srv.call("ha_get_config");
    assert.ok(!r.isError, r.text);
    assert.deepEqual(fake.writes(), []);
  } finally {
    await srv.stop();
  }
});

test("every request is logged at INFO with tool name, and the path token is redacted", async () => {
  const srv = await startMcp({ fake });
  try {
    await srv.call("ha_list_domains");
    // path-token form
    await fetch(`${srv.url}/mcp/${MCP_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "160.79.104.10" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await fetch(`${srv.url}/mcp/wrong`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await new Promise((r) => setTimeout(r, 200));
    const out = srv.logs.join("");
    assert.match(out, /INFO\s+POST \/mcp tools\/call ha_list_domains from .* -> 200/);
    assert.match(out, /INFO\s+tool ha_list_domains \{\} -> ok \(\d+ms\)/);
    assert.match(out, /INFO\s+POST \/mcp\/\*\*\* tools\/list from 160\.79\.104\.10 -> 200/);
    assert.match(out, /WARNING POST \/mcp\/\*\*\* .* -> 401/);
    assert.ok(!out.includes(MCP_TOKEN), "auth token must never appear in logs");
  } finally {
    await srv.stop();
  }
});

test("LOG_LEVEL=warning hides per-request INFO lines", async () => {
  const srv = await startMcp({ fake, env: { LOG_LEVEL: "warning" } });
  try {
    await srv.call("ha_list_domains");
    await new Promise((r) => setTimeout(r, 200));
    const out = srv.logs.join("");
    assert.ok(!/ INFO /.test(out), "unexpected INFO lines:\n" + out);
  } finally {
    await srv.stop();
  }
});
