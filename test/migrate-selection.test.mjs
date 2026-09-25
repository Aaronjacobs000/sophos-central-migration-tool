// The Start migration page reads the selected devices from the side they are on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const js = await readFile(new URL("../frontend/js/page-migrate.js", import.meta.url), "utf8");

test("the selection list reads devices from the sending side", () => {
  assert.match(js, /renderSelection\(ids, direction\)/);
  const body = js.slice(js.indexOf("async function renderSelection"), js.indexOf("function wireForm"));
  assert.match(body, /const side = direction === "dest-to-source" \? "dest" : "source";/);
  assert.match(body, /api\.get\(`\/api\/\$\{side\}\/endpoints\//);
  assert.doesNotMatch(body, /\/api\/source\/endpoints/);
});
