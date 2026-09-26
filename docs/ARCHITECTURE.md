# Architecture

## Deployment picture

```
claude.ai (Anthropic servers, 160.79.104.0/21)
   │  HTTPS, MCP Streamable HTTP, POST /mcp (+ token)
   ▼
Cloudflare tunnel ── Access policy: Bypass for Anthropic IPs, everyone else 403
   ▼
Home Assistant host
 └─ add-on container "ha-mcp"   (port 3000)
     s6-overlay → /usr/bin/ha-mcp-run (options.json → env) → node dist/index.js
       ├─ HA Core API     http://supervisor/core   (REST + websocket, $SUPERVISOR_TOKEN)
       ├─ Supervisor API  http://supervisor        (management only)
       └─ HA config dir   /homeassistant           (config-files only; mapped read-write)
```

Outside HA the same server runs as plain Docker/Node with `HA_URL` + `HA_TOKEN`
(long-lived token) and no Supervisor; stdio transport is available for local
Claude Desktop / Claude Code.

## Startup

1. **Entrypoint** `ha-mcp/rootfs/usr/bin/ha-mcp-run` (POSIX sh + jq):
   reads `/data/options.json`, exports the ENV CONTRACT, generates and persists
   `/data/auth_token` on first run (prints it in full only then), logs which
   write switches are on. Without options.json (plain Docker) it just execs node.
2. **`src/config.ts`** `loadConfig()` parses env → `Config` (capabilities set,
   blocked domains, log level). Refuses to start without `HA_URL`/`HA_TOKEN`,
   or with an auth token shorter than 32 chars. The header comment is the
   authoritative ENV CONTRACT.
3. **`src/index.ts`** builds one `HAClient` (shared) and starts express.

## Request flow (HTTP transport)

```
POST /mcp  or  /mcp/<token>        (case-sensitive routes)
 │
 ├─ logging middleware   registers an on-finish hook → one INFO line:
 │                         "POST /mcp/*** tools/call ha_get_state from <ip> -> 200 (12ms)"
 ├─ auth                 Bearer header or path token, constant-time compare
 ├─ express.json()       body parsed ONLY after auth (5 MB limit)
 └─ handle               new McpServer + StreamableHTTPServerTransport per request
                           (stateless: no sessions; GET/DELETE → 405)
      └─ registerAllTools(ctx)       tools/index.ts
           read.ts                    always
           actions.ts                 if ha.has("actions")
           config-files.ts            if ha.has("config") && CONFIG_DIR set
           management.ts              if ha.has("management")
           supervisor.ts              if ha.has("management") && Supervisor configured
      └─ tool handler  (wrapped by defineTool: logs "tool <name> <args> -> ok|error (ms)")
           └─ HAClient  →  HA REST / websocket / Supervisor
```

The server `instructions` (sent at MCP initialize) tell Claude which
capabilities are on, which domains are blocked, and to confirm before changes.

## Capability gates (two layers)

1. **Registration**: tools of a disabled capability are never registered, so
   Claude doesn't see them.
2. **`HAClient` enforcement** (the real boundary): every non-read request names
   a capability and throws before any I/O if it's off.

| Client method | Allowed when |
|---|---|
| `get(path)` | always (GET `/api/*` only; non-`/api/` paths refused) |
| `renderTemplate(t)` | always — POST `/api/template`, for fixed internal templates |
| `renderTemplateWithTimeout(t, s)` | always — websocket `render_template` with `timeout` (user templates) |
| `wsRead(type)` | always, if `type` ∈ `READ_ONLY_WS_COMMANDS` |
| `post(path, body, cap)` / `delete(path, cap)` | `cap` enabled (never `"read"`); `/api/services/*` refused → use `callService` |
| `ws(type, payload, cap)` | read-only commands always; others need `cap`; `call_service` refused |
| `callService(d, s, opts, cap)` | `cap` enabled **and** system-service rule **and** blocked-domain checks |
| `supervisor(method, path, body)` | `management` enabled and Supervisor configured; unwraps `{result,data}` |

**System services** (`SYSTEM_SERVICES` / `systemServiceLevel()`): `hassio.*`,
`homeassistant.*` (except turn_on/off/toggle/update_entity), `update.*`,
`backup.*`, `recorder.*`, `logger.*`, `system_log.*`, `cloud.*`, `*.reload*`.
With `actions` they're refused; reloads need `config`; the rest need
`management`.

**Blocked domains** (`assertNotBlocked`): normalises entity ids from `target`
and `data` (comma split, trim, lowercase), refuses `all` and non-entity ids
(UUIDs), expands area/floor/device/label targets and `group.*` via a template,
deep-scans data strings for `<blocked>.<id>`, refuses `scene.apply`,
`scene.create`, `group.set`, intent APIs, and Assist when it can reach a
blocked entity. Limits: `BLOCKED_DOMAINS_LIMITS` in `ha-client.ts`.

## Websocket usage

`wsRaw` opens a fresh connection per command (auth → command → close). Simple
and robust for a low-traffic server; if traffic grows, a pooled connection is a
possible optimisation. Subscription commands (`render_template`) wait for the
first `event` after the `result`.

## Tool modules

| Module | Capability | Notes |
|---|---|---|
| `tools/read.ts` | read | 12 tools; area lookups via fixed templates; error log via ws `system_log/list` |
| `tools/actions.ts`, `actions/shared.ts` | actions | 18 tools; entities checked to exist first; returns new states; multi-call plans are fully checked before the first call; 30 s services cache |
| `tools/config-files.ts` + `config-files/` | config | `sandbox.ts` (path resolution, realpath, deny lists, `.storage` allowlist, atomic writes with TOCTOU re-checks), `redact.ts` (secret redaction in YAML/JSON/text, `**REDACTED**`), `backups.ts` (`.ha-mcp-backups/<path>.<ts>.bak`, keep 20), `yaml-ha.ts` (HA custom tags, validation), `diff.ts` |
| `tools/management.ts` + `management/` | management | HA Core: `integrations.ts` (config/options/repair flows), `registries.ts`, `automations.ts` (validate then save; traces; blueprints), `helpers.ts` (input_*, counter, timer, schedule, person, zone, tag, users), `system.ts` (restart, repairs, updates, logger, recorder), `util.ts` |
| `tools/supervisor.ts` | management + Supervisor | add-ons, store, backups/restore, jobs, core/supervisor/OS/host, logs, resolution; self-protection (won't stop/update/uninstall/reconfigure/restore over itself) |

See `docs/TOOLS.md` for the full generated catalog.

## Logging

`logger.ts`: levels trace…fatal (add-on option `log_level`), stderr, one line
per event (control chars escaped). Per request: method, redacted path,
JSON-RPC method/tool (sanitised), client IP (from `CF-Connecting-IP`,
informational only), status, duration. Per tool call: name, args (secret keys
masked, bulky args as sizes, 300-char cap), result, duration. HA calls at
`debug`.

## Adding a tool (checklist)

1. Pick the module by capability; use `defineTool(ctx, "ha_<verb>_<noun>", {title, description, inputSchema: {zod…}, annotations}, handler)`.
2. Descriptions matter — Claude chooses tools from them. Include an example.
3. Go through `ctx.ha` only; name the capability on writes.
4. Honest annotation; `confirm: true` for anything irreversible or disruptive.
5. Tests with the harness (see `docs/TESTING.md`), then `npm run docs:tools`.
