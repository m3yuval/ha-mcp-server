# Changelog

## Unreleased

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
