// A copy's message and its results list count the same things: items already
// on the destination are "already there", not copied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { countOutcomes, outcomeOf } from "../frontend/js/ui.js";

const page = (file) => readFile(new URL(`../frontend/js/${file}`, import.meta.url), "utf8");

// As the migrate routes return them: eleven created and one already on the destination.
const copied = [
  ...Array.from({ length: 11 }, (_, i) => ({ type: "scanning", sourceId: `s${i}`, ok: true, action: "create" })),
  { type: "scanning", sourceId: "s-dup", ok: true, action: "skip-exists" },
];

test("counts match the tags in the results list", () => {
  const n = countOutcomes(copied);
  assert.deepEqual(n, { created: 11, "would-create": 0, skipped: 1, failed: 0 });
  assert.equal(n.created, copied.filter((r) => outcomeOf(r) === "created").length);

  const mixed = [
    { ok: true, action: "dry-run-create" },
    { ok: true, action: "dry-run-overwrite" },
    { ok: true, action: "skip-exists" },
    { ok: false, action: "create", error: "refused" },
  ];
  assert.deepEqual(countOutcomes(mixed), { created: 0, "would-create": 2, skipped: 1, failed: 1 });
});

test("exclusions: the copy message counts created items, as the list does", async () => {
  const js = await page("page-exclusions.js");
  const copy = js.slice(js.indexOf('getElementById("basket-copy")'), js.indexOf("// One line of text"));
  assert.match(copy, /const n = countOutcomes\(res\.results \?\? \[\]\);/);
  assert.match(copy, /toast\(`Copied \$\{n\.created\} \/ failed \$\{n\.failed\}`/);
  assert.doesNotMatch(copy, /filter\(\(r\) => r\.ok\)/);
  const list = js.slice(js.indexOf("function showResults"));
  assert.match(list, /countOutcomes\(results\)/);
});
