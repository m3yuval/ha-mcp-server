# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Start by reading `AGENTS.md` (imported above), then the `docs/` file for the area you're changing.
- Before finishing any code change, run `cd ha-mcp && npm test` and make sure it's green; if you touched tools, run `npm run docs:tools` too.
- When several agents work in parallel, give each its own files (tool modules are split by capability for this reason) and keep `ha-client.ts`, `common.ts`, `index.ts`, `config.ts`, `logger.ts` and `test/helpers/harness.mjs` owned by one agent at a time.
- Commit messages: imperative subject, a short body explaining why. Don't push unless asked.
