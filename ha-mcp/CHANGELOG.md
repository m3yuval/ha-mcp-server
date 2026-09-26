# Changelog

## 0.2.0

New capabilities (each behind its own switch, all off by default):

- **Actions** (`enable_actions`, 18 tools): turn on/off/toggle, climate,
  covers, media players, values of helpers, scripts, scenes, automations,
  buttons, notifications, vacuums/mowers, to-do lists, Assist, events, and a
  generic `ha_call_service`. System actions (hassio, restart/stop, updates,
  backups, recorder, logger, cloud) are refused under this switch.
- **Config files** (`enable_config_files`, 12 tools): list/read/write/edit
  (exact replace or YAML path, comments kept)/delete YAML in the HA config
  folder; validation before writing; backups of every change with restore;
  secrets managed without ever returning values; config check and reloads.
  Credential files are refused; secret-looking values are redacted.
- **Management** (`enable_management`, 52 tools): integrations incl. adding
  them via config/options flows, areas/floors/labels/categories/devices/
  entities, UI automations/scripts/scenes with validation and traces,
  blueprints, helpers, people, zones, tags, users, repairs, updates, log
  levels, recorder, restart; plus Supervisor: add-ons, store repositories,
  backups/restore, jobs, core/supervisor/OS/host, logs, resolution center.
  Risky operations require `confirm: true`; the add-on protects itself.
- **`blocked_domains`**: action calls touching these domains are refused,
  including through areas, floors, devices, labels, groups and data. Best
  effort — see DOCS.

Logging:

- One INFO line per request (JSON-RPC method, tool, client IP, status,
  duration) and one per tool call (arguments shortened, secrets masked, file
  contents as a size). Log injection is prevented; the auth token is never
  logged (full token only on the very first start).

Security hardening (from an independent review):

- Auth token must be at least 32 characters; request bodies are parsed only
  after authentication; case-variant paths can't bypass log redaction.
- `ha_render_template` now renders over the websocket with a 3 s time limit,
  so a heavy template can't hang Home Assistant.

Add-on packaging (following the current Home Assistant app docs):

- New options: `log_level`, `enable_actions`, `enable_config_files`,
  `enable_management`, `blocked_domains`. All write switches are off by
  default, so a fresh install stays read-only.
- Now based on the Home Assistant base image (`ghcr.io/home-assistant/base:3.23`,
  Alpine + s6-overlay v3 + bashio) with Node.js from Alpine; `init: false`.
  The service runs under s6 and the container stops if the server exits.
- `run.sh` moved to `rootfs/usr/bin/ha-mcp-run` (same option → env mapping,
  plus the new options); started from an s6 service.
- Maps the Home Assistant config folder read-write at `/homeassistant`
  (`CONFIG_DIR`) for the config file tools.
- Supervisor API access (`hassio_api`, `hassio_role: manager`) for the
  management tools; only used when `enable_management` is on.
- Custom AppArmor profile (`apparmor.txt`).
- Add-on icon and logo.
- Name is now "Home Assistant MCP" (no longer read-only only).
- CI: tests on Node 22 and 24, ShellCheck, the add-on linter, and a test build
  of the amd64/aarch64 images with the official builder action (no push).
- `.env.example` / `docker-compose.yml` document the new env vars for running
  outside Home Assistant.

## 0.1.1
- Fix `ha_get_error_log`: HA removed the `/api/error_log` endpoint, so errors are
  now read through the websocket `system_log/list` command (read-only,
  allowlisted). Supports filtering by level and text; newest first.
- Fix `ha_list_calendars` failing when no calendar integration is set up
  (now returns an empty list)
- `ha_list_entities` accepts area names or ids, and reports unknown areas
  instead of returning an empty list
- Clearer error for unknown calendar entities

## 0.1.0
- First release: read-only tools (config, domains, entities, state, areas,
  services, history, logbook, calendars, error log, templates)
- Runs as a Home Assistant add-on using the Supervisor token
