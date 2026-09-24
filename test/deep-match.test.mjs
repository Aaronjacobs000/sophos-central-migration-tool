// The Policies page's deep match: priority is not a difference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { computeDeepMatch } = await import("../backend/dist/routes/compare.js");

const policies = { src: [], dst: [] };
for (const [tenant, side] of [[SRC, "src"], [DST, "dst"]]) {
  fake.on(tenant, "GET", "/endpoint/v1/policies", (req) => page(policies[side], req.query));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
    const p = policies[side].find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound", message: "no such policy" } };
  });
}

const settings = { "endpoint.web-control.web-filtering.enabled": { value: true } };
const statusOf = (res, name) => res.matches.find((m) => m.name === name);

test("a clone at a different priority matches", async () => {
  policies.src = [{ id: "s1", name: "Clone", type: "web-control", enabled: true, enforced: false, priority: 3, settings }];
  policies.dst = [{ id: "d1", name: "Clone", type: "web-control", enabled: true, enforced: false, priority: 1, settings }];
  const m = statusOf(await computeDeepMatch(), "Clone");
  assert.equal(m.status, "match");
  assert.equal(m.diffCount, 0);
});

test("enabled and settings still count", async () => {
  policies.src = [
    { id: "s1", name: "Off", type: "web-control", enabled: true, priority: 3, settings },
    { id: "s2", name: "Setting", type: "web-control", enabled: true, priority: 2, settings },
  ];
  policies.dst = [
    { id: "d1", name: "Off", type: "web-control", enabled: false, priority: 1, settings },
    { id: "d2", name: "Setting", type: "web-control", enabled: true, priority: 2, settings: { "endpoint.web-control.web-filtering.enabled": { value: false } } },
  ];
  const res = await computeDeepMatch();
  assert.deepEqual([statusOf(res, "Off").status, statusOf(res, "Off").diffCount], ["differ", 1]);
  assert.deepEqual([statusOf(res, "Setting").status, statusOf(res, "Setting").diffCount], ["differ", 1]);
});
