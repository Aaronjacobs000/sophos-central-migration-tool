// Sophos refuses a policy write with more than 1000 applications in an
// application control list, with a bare 400 (measured 26/09/2026), and every
// write replaces the whole list. A longer list is not sent, and the result
// says why and gives the count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { migratePolicies } = await import("../backend/dist/services/policy-migrator.js");

const CONTROLLED = "endpoint.application-control.controlled-applications";
const ALLOWED = "endpoint.application-control.allowed-applications";
const apps = (n, prefix = "App") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

const policies = { src: [], dst: [] };
for (const [tenant, side] of [[SRC, "src"], [DST, "dst"]]) {
  fake.on(tenant, "GET", "/endpoint/v1/policies", (req) => page(policies[side], req.query));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
    const p = policies[side].find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound", message: "no such policy" } };
  });
}
// As the live API answers: more than 1000 in either list is a bare 400.
fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
  const s = req.body.settings ?? {};
  if ([CONTROLLED, ALLOWED].some((k) => (s[k]?.value?.length ?? 0) > 1000)) return { status: 400, body: { error: "BadRequest" } };
  return { status: 201, body: { id: fake.nextId("pol"), ...req.body } };
});

const appPolicy = (id, name, controlled, allowed = []) => ({
  id, name, type: "application-control", enabled: true, priority: 1,
  settings: {
    [CONTROLLED]: { value: controlled },
    [ALLOWED]: { value: allowed },
    "endpoint.application-control.detection.on-access.enabled": { value: true },
  },
});

test("a list over 1000 is not sent, and the result gives the count", async () => {
  policies.src = [
    appPolicy("a1", "Big", apps(3035)),
    appPolicy("a2", "Both big", apps(1001), apps(1200, "Allowed")),
  ];
  fake.reset();
  const audited = (await readAudit(root)).length;
  const res = await migratePolicies({ policyIds: ["a1", "a2"] });
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(res.map((r) => [r.ok, r.action]), [[false, "create"], [false, "create"]]);
  assert.equal(
    res[0].error,
    "the policy lists 3035 controlled applications, and Sophos accepts at most 1000 per list through its API, so it was not sent: cut the list to 1000 or fewer on the source and clone again, or build this policy on the destination in Sophos Fusion",
  );
  assert.match(res[1].error, /^the policy lists 1001 controlled applications and 1200 allowed applications, and Sophos accepts at most 1000 per list/);
  for (const r of res) assert.doesNotMatch(r.error, /[–—]/);
  assert.equal((await readAudit(root)).length, audited, "nothing written, nothing audited");

  const [dry] = await migratePolicies({ policyIds: ["a1"], dryRun: true });
  assert.deepEqual([dry.ok, dry.action], [false, "dry-run-create"]);
  assert.match(dry.error, /3035 controlled applications/);
});

test("1000 in each list is sent as it is", async () => {
  policies.src = [appPolicy("a3", "At the limit", apps(1000), apps(1000, "Allowed"))];
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["a3"] });
  assert.equal(res.ok, true, res.error);
  const post = fake.writes().find((w) => w.path === "/endpoint/v1/policies");
  assert.equal(post.body.settings[CONTROLLED].value.length, 1000);
  assert.equal(post.body.settings[ALLOWED].value.length, 1000);
});
