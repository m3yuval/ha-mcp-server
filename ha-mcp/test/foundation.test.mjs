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

test("all capabilities on: every module registers together, no name clashes, write tools annotated", async () => {
  const srv = await startMcp({
    fake,
    env: { ENABLE_ACTIONS: "true", ENABLE_CONFIG_FILES: "true", ENABLE_MANAGEMENT: "true", CONFIG_DIR: process.cwd() },
  });
  try {
    const tools = await srv.tools();
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool names");
    assert.ok(names.length > 80, `expected the full tool set, got ${names.length}`);
    for (const t of tools) {
      assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} missing readOnlyHint`);
      if (!t.annotations.readOnlyHint) assert.equal(typeof t.annotations.destructiveHint, "boolean", `${t.name} missing destructiveHint`);
      assert.ok((t.description ?? "").length > 20, `${t.name} needs a real description`);
    }
    // Instructions tell Claude to confirm before changes
    const info = srv.client.getInstructions();
    assert.match(info, /get confirmation/);
  } finally {
    await srv.stop();
  }
});

test("bulky arguments (file contents) are logged as a size, not as text", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "ha-mcp-log-"));
  const srv = await startMcp({ fake, env: { ENABLE_CONFIG_FILES: "true", CONFIG_DIR: dir } });
  try {
    const r = await srv.call("ha_write_config_file", { path: "notes.yaml", content: "marker: SECRET-FILE-BODY\n" });
    assert.ok(!r.isError, r.text);
    assert.match(await readFile(join(dir, "notes.yaml"), "utf8"), /SECRET-FILE-BODY/);
    await new Promise((r) => setTimeout(r, 150));
    const out = srv.logs.join("");
    assert.match(out, /tool ha_write_config_file .*"content":"<\d+ chars>"/);
    assert.ok(!out.includes("SECRET-FILE-BODY"), out);
  } finally {
    await srv.stop();
  }
});
