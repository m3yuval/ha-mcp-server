# AGENTS.md

Context for AI coding agents (and humans) working in this repo. Read this first,
then the doc for the area you're touching.

## What this is

A **Home Assistant add-on** that runs an **MCP server** (TypeScript, Node 22+),
so Claude can read and — only when the user turns on a switch — control a real
home. It is exposed to the internet (typically a Cloudflare tunnel restricted to
Anthropic's IP range, plus a secret token) and used as a claude.ai custom
connector. It is generic: nothing in this repo may be specific to one person's
Home Assistant (no hostnames, IPs, entity names, tokens).

**Safety is the core requirement.** A fresh install is read-only. Every write
ability is behind its own add-on option, off by default:

| Capability | Add-on option / env | Unlocks |
|---|---|---|
| `read` | always | inspect states, areas, history, logbook, calendars, error log, services, templates |
| `actions` | `enable_actions` / `ENABLE_ACTIONS` | control devices (service calls) — **not** system services |
| `config` | `enable_config_files` / `ENABLE_CONFIG_FILES` | create/edit YAML in the HA config dir; reloads |
| `management` | `enable_management` / `ENABLE_MANAGEMENT` | integrations, registries, automations, helpers, users, and Supervisor (add-ons, backups, host, updates) |

Plus `blocked_domains` / `BLOCKED_DOMAINS` (e.g. `lock,alarm_control_panel`):
a best-effort guard rail on action calls, **not** a security boundary.

## Repo map

```
AGENTS.md, CLAUDE.md        ← you are here
README.md                   user-facing overview
repository.yaml             HA add-on repository manifest
docs/
  ARCHITECTURE.md           request flow, capability gates, module layout
  SECURITY.md               threat model, invariants, known limits, review history
  TESTING.md                test harness, how to add tests, live testing
  DECISIONS.md              why things are the way they are (read before "fixing" them)
  TOOLS.md                  GENERATED tool catalog (npm run docs:tools)
.github/workflows/ci.yaml   tests (Node 22/24), ShellCheck, add-on linter, image build
ha-mcp/                     the add-on (Docker build context)
  config.yaml               add-on manifest: options schema, permissions, map, ports
  Dockerfile                HA base image + nodejs; multi-stage build; HEALTHCHECK
  apparmor.txt              AppArmor profile
  rootfs/usr/bin/ha-mcp-run options.json → env vars (plain sh + jq, testable)
  rootfs/etc/services.d/    s6-overlay service (run/finish)
  DOCS.md                   shown in HA's add-on "Documentation" tab (user docs)
  CHANGELOG.md              shown in HA on update
  translations/en.yaml      option labels in the HA UI
  src/
    index.ts                HTTP server (Streamable HTTP, stateless), auth, request logging
    config.ts               ENV CONTRACT (header comment) → Config
    logger.ts               leveled logger, secret redaction, one line per event
    ha-client.ts            THE ONLY path to HA/Supervisor; all capability gates live here
    tools/common.ts         defineTool() (logging + errors), annotations, helpers
    tools/index.ts          registers modules per enabled capability
    tools/read.ts           read tools
    tools/actions.ts (+actions/)            capability: actions
    tools/config-files.ts (+config-files/)  capability: config  (sandbox, redact, backups, yaml, diff)
    tools/management.ts (+management/)      capability: management (HA Core)
    tools/supervisor.ts                     capability: management (Supervisor API)
  scripts/gen-tools-doc.mjs regenerates docs/TOOLS.md
  test/                     node:test suites + helpers/harness.mjs (fake HA + Supervisor)
```

## Commands

Run from `ha-mcp/`:

```bash
npm ci
npm test            # builds (tsc) then runs every test/*.test.mjs (~120 tests, ~1–2 min)
npm run build       # tsc → dist/
npm run docs:tools  # regenerate docs/TOOLS.md (a test fails if it's stale)
node --test test/actions.test.mjs   # one suite (run `npm run build` first)
```

Entrypoint (no HA needed): `DATA_DIR=/tmp/d APP_DIR=/path/to/app HA_CONFIG_MOUNT=/tmp/cfg sh rootfs/usr/bin/ha-mcp-run`
with a `/tmp/d/options.json`. There is usually no Docker daemon in agent
sandboxes; CI builds the image.

## Rules for changes (non-negotiable)

1. **All HA/Supervisor I/O goes through `HAClient`** (`src/ha-client.ts`). Never
   call `fetch()` or open a `WebSocket` in a tool module. Writes must name a
   capability: `ha.post(path, body, cap)`, `ha.delete(path, cap)`,
   `ha.ws(type, payload, cap)`, `ha.callService(domain, service, opts, cap)`,
   `ha.supervisor(...)` (management only). Reads: `ha.get`, `ha.wsRead` (allowlist),
   `ha.renderTemplate` (fixed internal templates), `ha.renderTemplateWithTimeout`
   (user templates).
2. **Service calls only via `callService`** (it enforces blocked domains and the
   system-service rules). `post("/api/services/...")` and ws `call_service` throw.
3. **Register every tool with `defineTool()`** (`src/tools/common.ts`) — it logs
   each call and turns errors into MCP tool errors. Annotate honestly:
   `READ_ONLY`, `WRITE` (state change, easily undone), `DESTRUCTIVE` (deletes,
   overwrites, restarts, stops, installs, restores, anything generic). Truly
   risky operations also require an explicit `confirm: true` argument and must
   send nothing without it.
4. **Only add a websocket command to `READ_ONLY_WS_COMMANDS`** after checking HA
   core source that it cannot change anything.
5. **Never log secrets or file contents.** Arg names matching the logger's
   `SECRET_KEY` are masked; bulky args (`content`, `config`, …) are logged as a
   size. Name secret params accordingly (`password`, `secret_value`, …).
6. **Tests for every change**, using `test/helpers/harness.mjs`. Assert on the
   exact requests sent (`fake.requests`) and that refused operations send
   nothing. Security fixes need a test that fails without the fix.
7. **Tool changes → `npm run docs:tools`** and commit `docs/TOOLS.md`.
8. **User-visible changes → `ha-mcp/CHANGELOG.md`**, and bump `version` in both
   `ha-mcp/config.yaml` and `ha-mcp/package.json` plus `VERSION` in
   `src/index.ts` when releasing (HA only offers an update when `config.yaml`'s
   version changes).
9. **Keep it generic** — no instance-specific data anywhere, including tests.
10. **Docs must not over-promise.** If you weaken or change a guarantee, update
    `ha-mcp/DOCS.md` and `docs/SECURITY.md`.

## Where to look for…

- How a request flows, how gates work → `docs/ARCHITECTURE.md`
- What must never happen, and known holes → `docs/SECURITY.md`
- Writing tests, the fake HA, testing on a real HA → `docs/TESTING.md`
- "Why not X?" (base image, hassio_role, websocket error log, Bypass policy…) → `docs/DECISIONS.md`
- Every tool, its kind and parameters → `docs/TOOLS.md`
- User setup (Cloudflare, connector, options) → `ha-mcp/DOCS.md`
