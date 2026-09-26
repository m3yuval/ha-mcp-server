# ha-mcp-server

A **read-only** [MCP](https://modelcontextprotocol.io) server for Home Assistant. It lets Claude (or any MCP client) look at your home — entities, areas, history, logbook, calendars — without being able to change anything.

## Why it is read-only

The HA client in `src/ha-client.ts` can only send:

- `GET /api/*`
- `POST /api/template` (renders a Jinja template — cannot change state)

Any other request throws before it leaves the process. So there is no path to `/api/services/...` (running actions), `/api/states/...` writes, or firing events. The test suite also checks that no write request is ever sent.

> For defense in depth, create a dedicated HA user for this token. HA has no true read-only users yet, so the code-level block above is the main guard.

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
| `ha_get_error_log` | Tail of the HA error log |
| `ha_render_template` | Render a Jinja template (disable with `ENABLE_TEMPLATE_TOOL=false`) |

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Notes |
|---|---|---|
| `HA_URL` | yes | e.g. `http://homeassistant.local:8123` — as seen from where the server runs |
| `HA_TOKEN` | yes | HA → Profile → Security → Long-lived access tokens |
| `MCP_AUTH_TOKEN` | yes (http) | `openssl rand -hex 32`. Server refuses to start without it |
| `MCP_TRANSPORT` | no | `http` (default) or `stdio` |
| `PORT` / `HOST` | no | Default `3000` / `0.0.0.0` |
| `ENABLE_TEMPLATE_TOOL` | no | Default `true` |

## Run

```bash
# Docker (recommended, e.g. on the same machine as HA)
cp .env.example .env   # fill it in
docker compose up -d --build
curl http://localhost:3000/health

# Or plain Node 20+
npm ci && npm run build
HA_URL=... HA_TOKEN=... MCP_AUTH_TOKEN=... npm start
```

## Connect to Claude

### claude.ai (web / desktop / mobile) — remote connector

1. Expose the server over HTTPS, e.g. with a Cloudflare Tunnel pointing to `http://localhost:3000`.
2. In claude.ai: **Settings → Connectors → Add custom connector**.
3. URL: `https://<your-host>/mcp/<MCP_AUTH_TOKEN>`

claude.ai connectors can't send custom headers, so the token goes in the path. Treat that URL as a secret.

**Lock it down to Anthropic's IPs.** Remote connector calls come from Anthropic's servers, which use a stable published range: `160.79.104.0/21` ([docs](https://platform.claude.com/docs/en/api/ip-addresses)). In Cloudflare, add a WAF custom rule on your hostname:

```
(http.host eq "ha-mcp.example.com" and not ip.src in {160.79.104.0/21})  →  Block
```

Note: Cloudflare Access login pages will break the connector (it can't do an interactive login), so use the WAF rule + path token rather than Access.

### Claude Code / Claude Desktop — local stdio

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "node",
      "args": ["/path/to/ha-mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "HA_URL": "http://homeassistant.local:8123",
        "HA_TOKEN": "..."
      }
    }
  }
}
```

Or for Claude Code over HTTP: `claude mcp add --transport http home-assistant https://<host>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`

## Development

```bash
npm ci
npm run build
npm test      # starts a fake HA and calls every tool over MCP
```

## Roadmap

- [x] Read-only tools
- [ ] Write actions (`call_service`) behind an explicit allowlist of domains/entities
- [ ] Home Assistant add-on packaging
- [ ] OAuth for claude.ai instead of path token
