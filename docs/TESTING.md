# Testing

## Run

```bash
cd ha-mcp
npm ci
npm test                               # build + all suites (~120 tests)
npm run build && node --test test/config-files.test.mjs   # one suite
```

CI (`.github/workflows/ci.yaml`) runs the tests on Node 22 and 24, ShellCheck on
the entrypoint, the official add-on linter, and a no-push image build for
amd64 + aarch64 with the official builder action. The image build is the only
place the Dockerfile is exercised — agent sandboxes usually have no Docker.

## Suites

| File | Covers |
|---|---|
| `client.test.mjs` | `HAClient` gates without network (port 9): capabilities, system services, blocked domains, template timeout |
| `foundation.test.mjs` | registration per capability, request/tool logging, log injection, token redaction, all modules together, bulky-arg logging |
| `e2e.test.mjs` | original read tools end to end with its own small fake HA |
| `actions.test.mjs` | every action tool's request shape, annotations, blocked domains, system-service refusal |
| `config-files.test.mjs` | sandbox (traversal, symlinks, TOCTOU), deny lists, `.storage` allowlist, redaction, edits, backups/restore, check/reload |
| `management.test.mjs` | HA Core management: flows, registries, automations, helpers, users (confirm), system |
| `supervisor.test.mjs` | Supervisor tools: endpoints, confirm gates, self-protection, slug validation, secret masking |
| `docs.test.mjs` | `docs/TOOLS.md` matches the registered tools |

## The harness (`test/helpers/harness.mjs`)

```js
import { startFakeHA, startMcp, reply } from "./helpers/harness.mjs";

const fake = await startFakeHA({
  rest: {                                   // "METHOD /path" or prefix "METHOD /path*"
    "GET /api/states/*": ({ path }) => ({ entity_id: path.split("/").pop(), state: "on", attributes: {} }),
    "POST /api/services/light/turn_on": ({ body }) => [],
    "GET /api/missing": () => reply(404, "404: Not Found"),
  },
  ws: {                                     // websocket command → result
    "config/area_registry/list": () => [{ area_id: "kitchen", name: "Kitchen" }],
    "render_template": () => ({ __events: [{ result: "42" }], result: null }),   // subscription style
  },
  supervisor: { "GET /addons": () => ({ addons: [] }) },   // wrapped in {result:"ok",data}
});
const srv = await startMcp({ fake, env: { ENABLE_ACTIONS: "true", BLOCKED_DOMAINS: "lock" } });
const r = await srv.call("ha_turn_on", { entity_ids: ["light.kitchen"] });   // { text, isError, json }
fake.requests;      // every REST / ws / supervisor request, in order
fake.writes();      // only state-changing ones
srv.logs.join("");  // server stderr (log assertions)
await srv.stop(); await fake.stop();
```

`defaultRest()` provides a small home (`light.kitchen`, `light.bedroom`,
`lock.front_door`, `sensor.outdoor_temp`). `startMcp({ withSupervisor: false })`
simulates running outside HA. Servers get OS-assigned ports and are killed if
they fail to start.

### Patterns

- **Refusals send nothing**: `assert.deepEqual(fake.writes(), [])` after the call.
- **Exact payloads**: find the request in `fake.requests` and `deepEqual` the body.
- **Annotations**: `(await srv.tools()).find(t => t.name === "x").annotations`.
- **Secrets**: assert the secret string is absent from `r.text` and `srv.logs`.
- **Config files**: use a temp dir (`fs.mkdtemp`) as `CONFIG_DIR`.

## Testing on a real Home Assistant

No real HA is reachable from CI or agent sandboxes. With the add-on deployed and
the connector attached to a Claude session, check at least:

1. `ha_get_config`, `ha_list_domains`, `ha_list_areas`, `ha_list_entities` (domain / area name / area id / search / unknown area → error).
2. `ha_get_state` with a missing entity (per-entity error), `ha_get_history`, `ha_get_logbook`, `ha_list_services {domain}`.
3. `ha_list_calendars` (empty list if no calendar integration), `ha_get_error_log {level: "ERROR"}`.
4. `ha_render_template` normal, and a heavy template (nested `range(1500)`) → must fail with "Exceeded maximum execution time" and HA must stay responsive.
5. The add-on **Log** tab shows one INFO line per request and per tool call, no token.
6. With a write switch on: exercise one tool per module on something harmless, then confirm the system-service refusal (e.g. `ha_call_service homeassistant.restart` with only actions on → refused).

Gotchas seen in practice:
- A Claude session caches tool schemas from when the connector loaded; new
  parameters may be sent as strings until a new chat. Test new params in a new chat.
- Cloudflare Access with **Allow** returns 302 to the connector; use **Bypass**.
