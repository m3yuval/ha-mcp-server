// docs/TOOLS.md is generated from the real tool registrations. If this fails,
// run `npm run docs:tools` and commit the result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generate, TOOLS_MD } from "../scripts/gen-tools-doc.mjs";

test("docs/TOOLS.md is up to date with the registered tools", async () => {
  const expected = await generate();
  const actual = await readFile(TOOLS_MD, "utf8").catch(() => "");
  assert.ok(actual === expected, "docs/TOOLS.md is stale: run `npm run docs:tools` in ha-mcp/ and commit it");
});
