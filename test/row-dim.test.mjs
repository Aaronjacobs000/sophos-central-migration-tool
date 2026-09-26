// Rows on both sides are dimmed, but their delete menus are not, and a
// source row already on the destination has a tick that is not dimmed either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { onDestCell, ON_DEST_HEADER } from "../frontend/js/ui.js";

const css = await readFile(new URL("../frontend/css/components.css", import.meta.url), "utf8");

test("every is-dim rule skips the tick and actions cells", () => {
  const rules = [...css.matchAll(/([^{}]*tr\.is-dim[^{}]*)\{([^}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
  assert.ok(rules.length > 0, "found the dimming rules");
  for (const r of rules.filter((x) => /opacity/.test(x.body))) {
    assert.match(r.sel, /td:not\(\.col-tick\):not\(\.col-actions\)$/, `${r.sel} would fade the tick or the menu`);
  }
});

test("the tick cell has a labelled tick only for a row already on the destination", () => {
  assert.match(onDestCell(true), /^<td class="col-tick"><span class="on-dest" role="img" title="Already on the destination" aria-label="Already on the destination"><svg /);
  assert.equal(onDestCell(false), `<td class="col-tick"></td>`);
  assert.match(ON_DEST_HEADER, /^<th class="col-tick"/);
});

// Each copy-from-source page, and the flag that says a source row is already on the destination.
const TICKED = { "page-groups.js": "onBoth", "page-exclusions.js": "onBoth", "page-web-filtering.js": "onBoth", "page-policies.js": "inDest" };

test("every copy page ticks source rows already on the destination, and only source rows", async () => {
  for (const [file, flag] of Object.entries(TICKED)) {
    const js = await readFile(new URL(`../frontend/js/${file}`, import.meta.url), "utf8");
    const cells = [...js.matchAll(/onDestCell\(([^)]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(cells, [flag], `${file} ticks by ${flag}`);
    // The tick follows the source checkbox cell, and its header follows the checkbox header.
    assert.match(js, /aria-label="Select [^"]*"\/><\/td>(\$\{onDestCell\(|\s*\$\{onDestCell\()/, `${file}: tick after the checkbox`);
    assert.match(js, /<th class="col-check"><\/th>\$\{ON_DEST_HEADER\}/, `${file}: tick header after the checkbox header`);
  }
});

test("pages that dim rows put their menus in the actions cell", async () => {
  for (const file of ["page-groups.js", "page-exclusions.js", "page-web-filtering.js"]) {
    const js = await readFile(new URL(`../frontend/js/${file}`, import.meta.url), "utf8");
    assert.match(js, /is-dim/, `${file} dims rows`);
    const menus = [...js.matchAll(/<td[^>]*>\$\{rowMenu\(/g)].map((m) => m[0]);
    assert.ok(menus.length > 0, `${file} renders a row menu`);
    for (const td of menus) assert.match(td, /class="col-actions"/, `${file}: ${td}`);
  }
});
