# Home Assistant MCP

Lets Claude work with your home through MCP: entities, areas, history, logbook,
calendars, available actions.

**A fresh install is read-only.** Claude can only look. Controlling devices,
editing config files and managing Home Assistant are separate switches, all
**off** by default (see [Capabilities & safety](#capabilities--safety)).

## Setup

1. Install and **Start** the add-on. No config is needed.
2. Open the **Log** tab. On the **first** start you'll see a line like:

   ```
   claude.ai connector URL:  https://<your-cloudflare-host>/mcp/5ebf24...
   ```

   The long hex string is your auth token. It's generated once, kept in the
   add-on's storage (included in backups), and **printed in full only on that
   first start** — later starts show it masked. Lost it? Set your own
   `auth_token` in Configuration (at least 32 characters, e.g.
   `openssl rand -hex 32`) and restart.

3. Expose port `3000` with Cloudflare (below).
4. In claude.ai: **Customize → Connectors → + → Add custom connector**. Choose
   **No sign-in**. Either:
   - URL `https://<host>/mcp/<token>`, or
   - URL `https://<host>/mcp` plus a request header `Authorization` =
     `Bearer <token>` (keeps the secret out of the URL — recommended).

## Options

| Option | Default | Meaning |
|---|---|---|
| `auth_token` | auto | Secret clients must send. Empty = generate once and keep it. Minimum 32 characters |
| `ha_token` | empty | Leave empty to use the add-on's Supervisor token. Set a long-lived token only to run as a specific HA user |
| `log_level` | `info` | `trace`, `debug`, `info`, `notice`, `warning`, `error` or `fatal` |
| `enable_template_tool` | `true` | Allow Claude to render Jinja templates (read-only, 3-second time limit) |
| `enable_actions` | `false` | Allow Claude to control devices (call actions/services) |
| `enable_config_files` | `false` | Allow Claude to create and edit YAML files in your HA config folder |
| `enable_management` | `false` | Allow Claude to manage integrations, registries, automations, helpers, add-ons, backups, updates, and restart HA or the host |
| `blocked_domains` | empty | Entity domains the action tools refuse to control (best effort, see below) |

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

- **Claude asks first.** The server tells Claude to describe every change and
  get your confirmation first. Tools that can remove data or disrupt the
  system (delete, overwrite, restart, uninstall, stop an add-on, restore a
  backup, change integrations) are marked *destructive* in MCP; the riskiest
  (host reboot, restore, uninstall, adding add-on repositories, admin users,
  restart) also require an explicit `confirm: true`. Everyday controls like
  turning on a light are marked as normal writes.
- **What `enable_actions` does NOT include.** System actions — `hassio.*`
  (add-ons, backups, host), `homeassistant.stop/restart`, `update.*`,
  `backup.*`, `recorder.*`, `logger.*`, `cloud.*` — are refused with only
  `enable_actions` on. Reloads need `enable_config_files`; the rest need
  `enable_management`.
- **Turn on only what you need.** Start read-only. Turn on `enable_actions`
  when you want Claude to control devices. `enable_config_files` and
  `enable_management` can break your setup: take a backup first.

### Blocked domains (best effort)

Add the domains you never want Claude to touch, for example:

```yaml
blocked_domains:
  - lock
  - alarm_control_panel
```

The server then refuses action calls on entities in those domains, including
entities reached through area, floor, device and label targets, old-style
`group.*` members, and entity ids mentioned anywhere in the action data. While
it is set, registry ids (UUIDs) and `all` are refused as targets, and so are
`scene.apply`, `scene.create`, `group.set`, the intent API, and Assist when
Assist can reach a blocked entity.

It **cannot** see what Home Assistant does on its own afterwards: scripts,
automations and scenes that act on blocked entities internally; input helpers,
buttons or events that trigger such automations; integrations that run
commands or send raw messages (`python_script`, `shell_command`,
`rest_command`, `mqtt.publish`, `remote.send_command`, Zigbee/Z-Wave/ESPHome
services and similar). Treat it as a guard rail against mistakes, not a
security boundary. For real isolation, don't wire those devices to anything
Claude can trigger, and keep `enable_config_files` and `enable_management`
off (with those on, Claude could write an automation that does it).

### Risks of `enable_config_files`

Write access to Home Assistant's YAML is effectively **code execution inside
Home Assistant Core**: YAML can define `shell_command`, `command_line`
sensors/switches, `python_script`s and `rest_command`s, with Home Assistant's
own privileges and network access. Only enable it if you'd trust Claude like
someone with admin access to your config folder, and review diffs before
reloading.

Secret protection is best effort: `secrets.yaml` values are never shown, and
values of secret-looking keys (password, token, api_key, private_key,
network_key, webhook_id, …) and passwords inside URLs are replaced by
`**REDACTED**` when files are read or diffed. But a client that can write YAML
can still get a secret out (for example a template sensor that renders a
`!secret`). Credential files are refused outright (`.ssh/`, `*.pem`, `*.key`,
`id_*` keys, service-account/OAuth JSON and token files, `.cloud/`, `.env`,
logs, databases). From `.storage/` only registries, dashboards, helpers,
persons, zones and config entries (with their data and options hidden) can be
read, never written. Every change is backed up to `.ha-mcp-backups/` first
and can be restored.

### `enable_management` means full admin

This gives Claude the same power as a Home Assistant administrator: install
add-ons and third-party repositories (which run their own code with broad
access), change any add-on's options, create admin users and reset passwords,
restore backups, and restart or shut down the system. The riskiest actions
need an explicit `confirm: true`, and options that run commands or install
packages in other add-ons are refused unless you specifically ask. The add-on
also refuses to stop, update, uninstall, reconfigure or restore over itself.
That self-protection is best effort, not a security boundary: anything with
admin access (a terminal add-on, an admin account) can still change this
add-on. Only turn management on if you'd trust Claude with your admin login.

### `ha_token` (limited HA user)

You can put a long-lived token of a **non-admin** user in `ha_token` to limit
what Claude can reach in Home Assistant Core. Home Assistant requires admin
for some APIs, so with a non-admin token these stop working: template
rendering (`ha_render_template` and lookups by area/device), the error log,
firing events, and blocked-domain checks for area/device/floor/label targets
(those calls are then refused, not allowed). Supervisor tools always use the
add-on's own permissions.

## Permissions

The add-on asks for:

| Permission | Why |
|---|---|
| `homeassistant_api` | Read (and, if allowed, control) Home Assistant through the Supervisor proxy, without a long-lived token |
| `hassio_api` + `hassio_role: manager` | The `enable_management` tools for add-ons, backups, host, and updates. `manager` is the smallest role that covers them: `default` only allows `info` calls, `homeassistant` only Core, `backup` only backups. `manager` does **not** allow changing add-on protection mode or wiping the data disk; `admin` is not needed |
| `map: homeassistant_config` (read-write) | The `enable_config_files` tools, at `/homeassistant` |
| Port `3000` | The MCP endpoint for your tunnel. It is also reachable from your local network, bypassing the Cloudflare IP rule (the auth token still applies). If your tunnel runs inside HA (Cloudflared add-on), you can disable the host port in the add-on's **Network** section and use the add-on hostname instead |

These permissions are fixed by the add-on, but the server only uses them when
the matching switch is on: with `enable_management` off it refuses every
Supervisor call, and with `enable_config_files` off it never writes to
`/homeassistant`.

The add-on ships its own AppArmor profile.

## Logging

At `log_level: info`, every request is logged on one line: HTTP method,
JSON-RPC method, tool name, client IP, status and duration. Each tool call is
also logged with its arguments, shortened, with anything that looks like a
secret (token, password, key, code, pin, …) masked and file contents logged
as a size only. Client-supplied text is sanitised so it can't forge log lines.
The auth token is never logged, except once on the very first start (see
Setup). The client IP comes from Cloudflare's `CF-Connecting-IP` header and is
informational only — nothing security-related depends on it.

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
