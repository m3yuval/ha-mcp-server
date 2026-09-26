# ha-mcp-server

A **read-only** [MCP](https://modelcontextprotocol.io) server for Home Assistant, packaged as a Home Assistant add-on. Claude can look at your home — entities, areas, history, logbook, calendars — without being able to change anything.

## Install as a Home Assistant add-on

1. **Settings → Add-ons → Add-on store → ⋮ → Repositories**, add:
   `https://github.com/m3yuval/ha-mcp-server`
2. Install **Home Assistant MCP (read-only)** and start it.
3. The **Log** tab shows your connector URL (`/mcp/<token>`).
4. Expose port `3000` with a Cloudflare tunnel, lock it to Anthropic's IPs (Access policy with action **Bypass**, or a WAF rule), and add it in claude.ai as a custom connector with **No sign-in**.

Full steps: [`ha-mcp/DOCS.md`](ha-mcp/DOCS.md).

> The add-on store can only install from a repo Home Assistant can clone. If this repo is private, HA can't add it — make it public (it contains no secrets) or copy `ha-mcp/` into a public add-on repository.

Inside HA the add-on uses the Supervisor token, so you don't need to create a long-lived token.

## Why it is read-only

The HA client (`ha-mcp/src/ha-client.ts`) can only send:

- `GET /api/*`
- `POST /api/template` (renders a Jinja template — cannot change state)
- websocket `system_log/list` (reads the error log)

Anything else throws before it leaves the process, so there's no path to running actions, writing states, or firing events. The test suite also checks that no write request is ever sent.

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

## Run outside Home Assistant

The same image runs as plain Docker or Node — configure with env vars instead of add-on options:

```bash
cd ha-mcp
cp .env.example .env   # HA_URL, HA_TOKEN, MCP_AUTH_TOKEN
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

```bash
cd ha-mcp
npm ci && npm run build
npm test      # starts a fake HA and calls every tool over MCP
```

## Roadmap

- [x] Read-only tools
- [x] Home Assistant add-on
- [ ] Write actions (`call_service`) behind an allowlist of domains/entities
- [ ] OAuth for claude.ai instead of path token
