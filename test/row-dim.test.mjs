// Rows on both sides are dimmed, but their delete menus are not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../frontend/css/components.css", import.meta.url), "utf8");

test("every is-dim rule skips the actions cell", () => {
  const rules = [...css.matchAll(/([^{}]*tr\.is-dim[^{}]*)\{([^}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
  assert.ok(rules.length > 0, "found the dimming rules");
  for (const r of rules.filter((x) => /opacity/.test(x.body))) {
    assert.match(r.sel, /td:not\(\.col-actions\)$/, `${r.sel} would fade the menu`);
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
