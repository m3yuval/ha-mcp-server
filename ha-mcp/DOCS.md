# Home Assistant MCP (read-only)

Lets Claude look at your home through MCP: entities, areas, history, logbook,
calendars, available actions. It **cannot change anything** — the server only
sends GET requests (plus template rendering) to Home Assistant, and refuses any
other request in code.

## Setup

1. Install and **Start** the add-on. No config is needed.
2. Open the **Log** tab. You'll see a line like:

   ```
   claude.ai connector URL:  https://<your-cloudflare-host>/mcp/5ebf24...
   ```

   The long hex string is your auth token. It's generated once and kept in the
   add-on's storage. To use your own, set `auth_token` in Configuration.

3. Expose port `3000` with Cloudflare (below).
4. In claude.ai: **Settings → Connectors → Add custom connector** and paste the
   URL with your real hostname.

## Options

| Option | Default | Meaning |
|---|---|---|
| `auth_token` | auto | Secret in the connector URL |
| `ha_token` | empty | Leave empty to use the add-on's Supervisor token. Set a long-lived token only to run as a specific HA user |
| `enable_template_tool` | `true` | Allow Claude to render Jinja templates (read-only) |

## Cloudflare

Point the tunnel at the add-on on port `3000`. From inside HA (e.g. the
Cloudflared add-on) use the add-on's hostname, shown on its **Info** page
(looks like `xxxxxxxx-ha-mcp`), or the host gateway `172.30.32.1`:

```
service: http://xxxxxxxx-ha-mcp:3000      # or http://172.30.32.1:3000
```

With the community **Cloudflared** add-on, add to its `additional_hosts`:

```yaml
- hostname: ha-mcp.example.com
  service: http://xxxxxxxx-ha-mcp:3000
```

With a dashboard-managed tunnel: **Zero Trust → Networks → Tunnels → your
tunnel → Public hostname → Add**, service `HTTP`, URL `xxxxxxxx-ha-mcp:3000`.

### Allow only Anthropic

claude.ai connector calls come from Anthropic's published range
`160.79.104.0/21`
([docs](https://platform.claude.com/docs/en/api/ip-addresses)). In Cloudflare:
**Security → WAF → Custom rules → Create**, expression:

```
(http.host eq "ha-mcp.example.com" and not ip.src in {160.79.104.0/21})
```

Action: **Block**.

Don't put Cloudflare Access (login page) in front of it — the connector can't
log in interactively. IP rule + secret URL is the combination to use.

## Check it works

- `https://ha-mcp.example.com/health` → `{"ok":true,...}` (only from an allowed IP
  once the WAF rule is on)
- In Claude, ask: "Using Home Assistant, which lights are on?"
