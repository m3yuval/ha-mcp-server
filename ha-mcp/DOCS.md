# Home Assistant MCP

Lets Claude work with your home through MCP: entities, areas, history, logbook,
calendars, available actions.

**A fresh install is read-only.** Claude can only look. Controlling devices,
editing config files and managing Home Assistant are separate switches, all
**off** by default (see [Capabilities & safety](#capabilities--safety)).

## Setup

1. Install and **Start** the add-on. No config is needed.
2. Open the **Log** tab. You'll see a line like:

   ```
   claude.ai connector URL:  https://<your-cloudflare-host>/mcp/5ebf24...
   ```

   The long hex string is your auth token. It's generated once and kept in the
   add-on's storage (it is included in backups). To use your own, set
   `auth_token` in Configuration.

3. Expose port `3000` with Cloudflare (below).
4. In claude.ai: **Customize → Connectors → + → Add custom connector**. Choose
   **No sign-in**. Either:
   - URL `https://<host>/mcp/<token>`, or
   - URL `https://<host>/mcp` plus a request header `Authorization` =
     `Bearer <token>` (keeps the secret out of the URL — recommended).

## Options

| Option | Default | Meaning |
|---|---|---|
| `auth_token` | auto | Secret in the connector URL. Empty = generate once and keep it |
| `ha_token` | empty | Leave empty to use the add-on's Supervisor token. Set a long-lived token only to run as a specific HA user |
| `log_level` | `info` | `trace`, `debug`, `info`, `notice`, `warning`, `error` or `fatal` |
| `enable_template_tool` | `true` | Allow Claude to render Jinja templates (read-only) |
| `enable_actions` | `false` | Allow Claude to control devices (call actions/services) |
| `enable_config_files` | `false` | Allow Claude to create and edit YAML files in your HA config folder |
| `enable_management` | `false` | Allow Claude to manage integrations, registries, automations, helpers, add-ons, backups, updates, and restart HA or the host |
| `blocked_domains` | empty | Entity domains Claude can never control, even with `enable_actions` on |

`auth_token` and `ha_token` are optional and hidden until you click
**Show unused optional configuration options**.

## Capabilities & safety

Each switch unlocks one group of tools. Tools for a switch that is off are not
offered to Claude at all, and the server also refuses those requests in code.

| Switch | What Claude can do when it's on |
|---|---|
| (always) | Read: config, entities and states, areas, history, logbook, calendars, error log, list of available actions |
| `enable_template_tool` | Render Jinja templates. Read-only, but a template can see everything in HA |
| `enable_actions` | Call actions: turn things on/off, set a thermostat, run a script or scene, etc. |
| `enable_config_files` | Create and edit YAML files in the HA config folder (`/homeassistant` inside the add-on) |
| `enable_management` | Integrations, entity/device/area registries, automations, scripts, helpers; add-ons (install, update, start/stop, options, logs); backups (create, restore, remove); updates of Core/Supervisor/OS; config check, restart; host reboot/shutdown |

Good to know:

- **Claude asks first.** Tools that change something are marked as
  destructive in MCP, so Claude asks you before it runs them. Read-only tools
  are marked read-only.
- **Blocked domains.** Anything in `blocked_domains` can never be controlled,
  even with `enable_actions` on. We recommend adding at least:

  ```yaml
  blocked_domains:
    - lock
    - alarm_control_panel
  ```

- **Turn on only what you need.** Start read-only. Turn on `enable_actions`
  when you want Claude to control devices. `enable_config_files` and
  `enable_management` can break your setup: take a backup first.
- **Limited HA user.** To limit what Claude can reach in Home Assistant Core,
  create a non-admin user, make a long-lived token for it, and put it in
  `ha_token`. (Supervisor tools always use the add-on's own permissions.)

## Permissions

The add-on asks for:

| Permission | Why |
|---|---|
| `homeassistant_api` | Read (and, if allowed, control) Home Assistant through the Supervisor proxy, without a long-lived token |
| `hassio_api` + `hassio_role: manager` | The `enable_management` tools for add-ons, backups, host, and updates. `manager` is the smallest role that covers them: `default` only allows `info` calls, `homeassistant` only Core, `backup` only backups. `manager` does **not** allow changing add-on protection mode or wiping the data disk; `admin` is not needed |
| `map: homeassistant_config` (read-write) | The `enable_config_files` tools, at `/homeassistant` |
| Port `3000` | The MCP endpoint for your tunnel |

These permissions are fixed by the add-on, but the server only uses them when
the matching switch is on: with `enable_management` off it refuses every
Supervisor call, and with `enable_config_files` off it never writes to
`/homeassistant`.

The add-on ships its own AppArmor profile.

## Logging

At `log_level: info`, every request is logged on one line: HTTP method,
JSON-RPC method, tool name, client IP, status and duration. Each tool call is
also logged with its arguments, shortened, and with anything that looks like a
secret (token, password, key) masked. The auth token is never logged (except
the connector URL line printed once at start, so you can copy it).

To keep the log quiet, set `log_level` to `warning`. Use `debug` when
something doesn't work.

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
([docs](https://platform.claude.com/docs/en/api/ip-addresses)). Two ways to
lock the hostname to it:

**Cloudflare Access** (Zero Trust → Access → Applications → your app → policy):
Include **IP ranges** `160.79.104.0/21`, action **Bypass**. Not **Allow** —
Allow still sends matching requests to the Access login page (you'll see a
`302` when adding the connector), and a connector can't log in. Make sure there
is no other Bypass/Everyone policy on the app.

**Or a WAF rule** (Security → WAF → Custom rules):

```
(http.host eq "ha-mcp.example.com" and not ip.src in {160.79.104.0/21})
```

Action: **Block**.

Either way, the auth token is still required on top. This matters more once
you turn on any of the write switches.

## Check it works

- `https://ha-mcp.example.com/health` → `{"ok":true,...}` from an allowed IP;
  `403` from anywhere else
- In Claude, ask: "Using Home Assistant, which lights are on?"
