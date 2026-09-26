# ha-mcp-server

An [MCP](https://modelcontextprotocol.io) server for Home Assistant, packaged as a Home Assistant add-on. Claude can look at your home — entities, areas, history, logbook, calendars.

**Read-only by default.** Controlling devices, editing config files and managing Home Assistant (add-ons, backups, updates, restarts) are separate switches, all off on a fresh install.

## Install as a Home Assistant add-on

1. **Settings → Add-ons → Add-on store → ⋮ → Repositories**, add:
   `https://github.com/m3yuval/ha-mcp-server`
2. Install **Home Assistant MCP** and start it.
3. The **Log** tab shows your connector URL (`/mcp/<token>`).
4. Expose port `3000` with a Cloudflare tunnel, lock it to Anthropic's IPs (Access policy with action **Bypass**, or a WAF rule), and add it in claude.ai as a custom connector with **No sign-in**.

Full steps: [`ha-mcp/DOCS.md`](ha-mcp/DOCS.md).

> The add-on store can only install from a repo Home Assistant can clone. If this repo is private, HA can't add it — make it public (it contains no secrets) or copy `ha-mcp/` into a public add-on repository.

Inside HA the add-on uses the Supervisor token, so you don't need to create a long-lived token.

### Options

| Option | Default | |
|---|---|---|
| `auth_token` / `ha_token` | empty | Connector secret (auto-generated) / optional long-lived token |
| `log_level` | `info` | Every request is logged at `info`; use `warning` to quiet it |
| `enable_template_tool` | `true` | Jinja template rendering (read-only) |
| `enable_actions` | `false` | Control devices / call actions |
| `enable_config_files` | `false` | Create/edit YAML in the HA config folder |
| `enable_management` | `false` | Integrations, registries, automations, helpers, add-ons, backups, updates, restart |
| `blocked_domains` | `[]` | Domains that can never be controlled — add `lock` and `alarm_control_panel` |

What each switch unlocks, the add-on's permissions, and logging: [`ha-mcp/DOCS.md`](ha-mcp/DOCS.md).

## Read-only by default

With every switch off, the server can only read: GET requests, template
rendering (with a time limit), and an allowlist of read-only websocket
commands. Anything else is refused inside the HA client before a request is
sent, and tests check that no write request is ever made. Each switch adds its
own tools (Claude never sees tools for a switch that is off); system actions
like restarting HA are never reachable from `enable_actions`, and risky tools
require an explicit confirmation. Details: [`docs/SECURITY.md`](docs/SECURITY.md).

## Tools

| Tool | What it does |
|---|---|
| `ha_get_config` | Version, location, time zone, units. Good connectivity check |
| `ha_list_domains` | Entity count per domain |
| `ha_list_entities` | Compact list, filter by `domain`, `area`, `search`, `state` |
| `ha_get_state` | Full state + attributes for one or more entities |
| `ha_list_areas` | Areas and the entities in each |
| `ha_list_services` | Available actions and their fields (discovery only) |
| `ha_get_history` | State changes over a time range |
| `ha_get_logbook` | What happened and why |
| `ha_list_calendars` / `ha_get_calendar_events` | Calendar entities and events |
| `ha_get_error_log` | Recent errors/warnings (Settings → System → Logs), filter by level or text |
| `ha_render_template` | Render a Jinja template (can be turned off) |

More tools appear when you turn on `enable_actions`, `enable_config_files` or `enable_management` — 94 in total. Full list: [`docs/TOOLS.md`](docs/TOOLS.md).

## Run outside Home Assistant

The same image runs as plain Docker or Node — configure with env vars instead of add-on options:

```bash
cd ha-mcp
cp .env.example .env   # HA_URL, HA_TOKEN, MCP_AUTH_TOKEN (+ optional ENABLE_* switches)
docker compose up -d --build
```

Local stdio for Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "node",
      "args": ["/path/to/ha-mcp/dist/index.js"],
      "env": { "MCP_TRANSPORT": "stdio", "HA_URL": "http://homeassistant.local:8123", "HA_TOKEN": "..." }
    }
  }
}
```

Auth over HTTP: `Authorization: Bearer <MCP_AUTH_TOKEN>` (claude.ai custom connectors can send this as a request header) or the token as the last path segment (`/mcp/<token>`).

## Development

Start with [`AGENTS.md`](AGENTS.md) (repo map, rules, commands), then
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SECURITY.md`](docs/SECURITY.md),
[`docs/TESTING.md`](docs/TESTING.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

```bash
cd ha-mcp
npm ci
npm test      # builds, then starts a fake HA and calls every tool over MCP
```

The add-on image is built from `ha-mcp/Dockerfile` (`docker build ha-mcp`). The add-on entrypoint is `ha-mcp/rootfs/usr/bin/ha-mcp-run` (plain `sh` + `jq`); it maps `/data/options.json` to the env vars above and can be tested outside HA with `DATA_DIR`, `APP_DIR` and `HA_CONFIG_MOUNT`. CI (`.github/workflows/ci.yaml`) runs the tests, the add-on linter, and a test build for amd64/aarch64.

## Roadmap

- [x] Read-only tools
- [x] Home Assistant add-on
- [x] Opt-in write capabilities (actions, config files, management) with blocked domains
- [ ] Prebuilt multi-arch images (faster install than a local build)
- [ ] OAuth for claude.ai instead of path token
