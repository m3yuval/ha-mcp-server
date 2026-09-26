# Changelog

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
