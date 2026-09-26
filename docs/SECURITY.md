# Security model

This server can control a real home and, with management on, administer Home
Assistant. Treat every change here as security-sensitive.

## Threat model

| Actor | Can they reach the server? | What stops them |
|---|---|---|
| Random internet | Cloudflare hostname | Cloudflare Access/WAF (only `160.79.104.0/21`), then the auth token |
| Other Claude users (same Anthropic IP range) | Yes, network-wise | **The auth token is the real boundary** (≥ 32 chars, constant-time compare) |
| Devices on the LAN | Port 3000 is published on the host | Auth token (Cloudflare rule doesn't apply on the LAN) |
| Claude itself (prompt-injected by content it reads: entity names, logs, file contents, web pages) | Authenticated | Capability switches off by default; system services not reachable from `actions`; `confirm: true` on risky ops; blocked domains; server instructions to confirm with the user |
| HA admins / other add-ons | Full access to HA anyway | Out of scope; self-protection is best effort only |

## Invariants (tests enforce these — keep them true)

1. With all switches off, **no request that can change state** leaves the
   process (only GET, fixed/timeout-limited template renders, and allowlisted
   read-only websocket commands). `foundation.test.mjs`, `client.test.mjs`.
2. A capability only unlocks itself; `"read"` is never accepted as a write
   capability.
3. Service calls go through `callService`; system services are refused under
   `actions`.
4. Tools for a disabled capability are not registered.
5. The auth token never appears in logs (except the one-time first-start line
   printed by the entrypoint); unauthenticated bodies are never parsed or logged.
6. Secret-named args are masked in logs; file contents are logged as sizes.
7. Config-file tools never read or write outside `CONFIG_DIR`, never follow
   escaping symlinks, never read credential files, never write `.storage`,
   never return `secrets.yaml` values.
8. Supervisor tools refuse to stop/update/uninstall/reconfigure this add-on or
   restore a backup over it without explicit override; risky ops need
   `confirm: true` and send nothing without it.

## Known limits (documented to users in `ha-mcp/DOCS.md`)

- **`blocked_domains` is a guard rail, not a boundary.** It can't see inside
  scripts/automations/scenes, helper-triggered automations, or command/raw
  integrations (`python_script`, `shell_command`, `rest_command`,
  `mqtt.publish`, `remote.send_command`, zha/zwave/esphome services…). Exact
  text: `BLOCKED_DOMAINS_LIMITS` in `src/ha-client.ts`.
- **`enable_config_files` ≈ code execution in HA Core** (YAML can define
  `shell_command` etc.). Secret redaction is best effort (a template sensor can
  render a `!secret`).
- **`enable_management` = full HA admin.** Self-protection is best effort:
  anything with admin access (terminal add-on, admin user) can reconfigure this
  add-on.
- The `hassio_role: manager` permission is always granted to the container; the
  server just refuses to use it unless management is on.
- Non-admin `ha_token`: some read features (templates, error log, event firing,
  indirect blocked-domain checks) need admin and fail closed.

## Review history

- **2026-09 independent review (v0.2.0 pre-release)** — findings and fixes:
  - H1 `actions` reached `hassio.*`/restart/updates via `ha_call_service` → system-service rules.
  - H2 blocked domains bypass via comma lists, spaces, case, UUIDs, target keys in `data` → normalisation, refusal.
  - H3 labels on devices/areas not expanded → `label_devices`/`label_areas` expansion.
  - H4 `scene.apply/create`, `group.set`, `conversation.process`, groups, entity ids in data → refused/expanded/deep-scanned.
  - M1 repo add / add-on install / options / admin users / restore-over-self without confirm → `confirm: true`, command-option guard, self checks.
  - M2 config files exposed SSH keys, service-account JSON, `.storage` secrets → deny lists, `.storage` allowlist, redaction.
  - M3 log injection, `/MCP/<token>` logged, bodies parsed pre-auth → sanitising, case-sensitive routes, auth-first parsing.
  - M4 `ha_render_template` could hang HA Core → websocket render with timeout (verified live: heavy template stopped at 3.0 s).
  - M5 docs over-promised → rewritten.
  - L1 logger missed `code`/`pin`/`psk`… → extended; L3 token length + masked log; L4 TOCTOU re-checks; L5 slug regex; L6 option masking.

When you change security-relevant code, add an entry here.

## Reporting

Open a private security advisory on the GitHub repo rather than a public issue.
