# Decisions

Short records of choices that look odd without context. Add new ones at the
bottom: date, decision, why, alternatives rejected.

### 1. MCP server as an HA add-on, reached through a Cloudflare tunnel (2026-09)
Claude's cloud can't reach a LAN, so the server must be public. Running it as
an add-on gives it the Supervisor token (no long-lived token to manage) and
co-locates it with HA. Rejected: running MCP in Claude's sandbox (not
persistent, can't become a connector).

### 2. Stateless Streamable HTTP, new McpServer per request
Simplest correct transport for claude.ai connectors; no session state to lose
on restart. GET/DELETE return 405.

### 3. Auth: path token *or* Bearer header
Early claude.ai connectors couldn't send headers, so `/mcp/<token>` exists. The
connector dialog now supports request headers; `Authorization: Bearer` is
preferred (keeps the secret out of URLs). Both are supported.

### 4. Cloudflare Access policy must be **Bypass**, not Allow
Allow still redirects matching requests to the Access login (302) — a connector
can't log in. Bypass for `160.79.104.0/21` + token works. A WAF block rule is
an alternative. Anthropic's outbound range is documented at
https://platform.claude.com/docs/en/api/ip-addresses.

### 5. Read-only by default; write abilities split into three switches
A generic public add-on must be safe on install. Switches map to blast radius:
actions (devices), config (files ≈ code exec), management (admin).

### 6. Gates live in `HAClient`, not in tools
One choke point is auditable and testable without spinning up tools. Tool
registration gating is a second, UX-level layer.

### 7. Error log via websocket `system_log/list`
HA removed `/api/error_log` (404 on 2026.9). The Supervisor's `/core/logs`
needs `hassio_role: homeassistant`+, which was too broad for read-only use at
the time. `system_log/list` is read-only and structured.

### 8. User templates via websocket `render_template` with `timeout`
POST `/api/template` has no time limit; a heavy template blocks HA Core.
Internal fixed templates still use POST.

### 9. `hassio_role: manager`
Smallest Supervisor role covering add-ons, store, backups, host, core,
supervisor and OS updates (checked in supervisor `api/middleware/security.py`).
`admin` not needed. The server refuses Supervisor calls unless management is on.

### 10. HA base image + s6-overlay, no `build.yaml`
Current HA app docs: `build.yaml` deprecated (Supervisor 2026.04); base image
`ghcr.io/home-assistant/base` with `init: false`. Node comes from Alpine
(nodejs ≥ 22 required for global `WebSocket`). No `watchdog` / default
`startup`/`boot` keys (linter: obsolete/default) — Docker `HEALTHCHECK` on
`/health` instead.

### 11. Entrypoint in plain sh + jq, not bashio
So the option → env mapping can be tested outside the Supervisor
(`DATA_DIR`/`APP_DIR`/`HA_CONFIG_MOUNT`). The s6 `run` script (bashio) just
execs it.

### 12. Local build, no prebuilt images (for now)
Simpler publishing. Downside: slower installs/updates, and HA docs plan to warn
on locally built apps. CI already builds images; enabling push + `image:` in
`config.yaml` is the upgrade path.

### 13. Auth token shown in full only once
Printed on first generation so the user can copy it; masked afterwards so it
doesn't sit in every restart's log (readable by any HA admin and by the add-on
log tool).

### 14. `blocked_domains` refuses rather than filters
Silently dropping blocked entities from a call would surprise users; refusing
the whole call (before sending anything) is predictable.

### 15. Tool catalog is generated
`docs/TOOLS.md` comes from real registrations (`scripts/gen-tools-doc.mjs`) and
a test fails when it's stale, so docs can't drift from code.
