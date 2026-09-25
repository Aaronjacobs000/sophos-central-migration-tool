// The Endpoints page can reload each side, so a device that has just moved shows on the receiving side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../frontend/endpoints.html", import.meta.url), "utf8");
const js = await readFile(new URL("../frontend/js/page-endpoints.js", import.meta.url), "utf8");

test("each side has a reload button", () => {
  for (const side of ["source", "dest"]) assert.match(html, new RegExp(`id="refresh-${side}"`));
});

test("the reload button refreshes that side's endpoints cache and redraws the table", () => {
  assert.match(js, /getElementById\(`refresh-\$\{side\}`\)\.addEventListener\("click", \(e\) => reloadSide\(side/);
  const body = js.slice(js.indexOf("async function reloadSide"), js.indexOf("function selectAll"));
  assert.match(body, /await refreshSection\(side, "endpoints"\)/);
  assert.match(body, /await loadSide\(side\)/);
});
