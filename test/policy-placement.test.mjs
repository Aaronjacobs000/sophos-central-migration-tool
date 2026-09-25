// Cloned policies go to the bottom of the destination's priority order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { migratePolicies } = await import("../backend/dist/services/policy-migrator.js");

const policies = { src: [], dst: [] };
fake.on(SRC, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
  const p = policies.src.find((x) => x.id === req.path.split("/").pop());
  return p ? { body: p } : { status: 404, body: { error: "NotFound", message: "no such policy" } };
});
fake.on(DST, "GET", "/endpoint/v1/policies", (req) => page(policies.dst, req.query));
fake.on(DST, "POST", "/endpoint/v1/policies", (req) => ({ status: 201, body: { id: fake.nextId("pol"), ...req.body } }));
fake.on(DST, "PATCH", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => ({ body: { id: req.path.split("/").pop(), ...req.body } }));

const settings = { "endpoint.web-control.web-filtering.enabled": { value: true } };
function seed() {
  policies.src = [
    { id: "a", name: "Low", type: "web-control", enabled: true, priority: 1, settings },
    { id: "b", name: "High", type: "web-control", enabled: true, priority: 3, settings },
    { id: "c", name: "Middle", type: "web-control", enabled: false, priority: 2, settings },
    { id: "t", name: "Servers", type: "threat-protection", enabled: true, priority: 7, settings: {} },
  ];
  policies.dst = [
    { id: "d1", name: "Existing", type: "web-control", enabled: true, priority: 1 },
    { id: "d0", name: "Base Policy", type: "web-control", enabled: true, priority: 0 },
  ];
}

test("clones ask for the bottom priority, highest source priority first; results keep request order", async () => {
  seed();
  fake.reset();
  const res = await migratePolicies({ policyIds: ["a", "b", "t", "c"] });
  const posts = fake.writes().filter((w) => w.method === "POST");
  assert.deepEqual(posts.map((w) => w.body.name), ["Servers", "High", "Middle", "Low"]);
  assert.ok(posts.every((w) => w.body.priority === 1), "every create asks for the bottom");
  assert.ok(posts.every((w) => !("appliesTo" in w.body)));
  assert.deepEqual(res.map((r) => r.sourceId), ["a", "b", "t", "c"]);
  assert.ok(res.every((r) => r.ok && r.action === "create"));
});

test("dry run: same order and plan, no writes", async () => {
  seed();
  fake.reset();
  const res = await migratePolicies({ policyIds: ["a", "b"], dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(res.map((r) => `${r.sourceId} ${r.action}`), ["a dry-run-create", "b dry-run-create"]);
});

test("overwrite leaves the destination policy where it is", async () => {
  seed();
  policies.src.push({ id: "e", name: "Existing", type: "web-control", enabled: false, priority: 4, settings });
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["e"], overwrite: true });
  assert.equal(res.action, "overwrite");
  const [patch] = fake.writes();
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, "/endpoint/v1/policies/d1");
  assert.equal("priority" in patch.body, false);
});

test("a source policy that cannot be read is reported in its own slot", async () => {
  seed();
  fake.reset();
  const res = await migratePolicies({ policyIds: ["a", "missing", "b"] });
  assert.equal(res[1].sourceId, "missing");
  assert.equal(res[1].ok, false);
  assert.match(res[1].error, /404/);
  assert.equal(res[0].ok && res[2].ok, true);
  assert.deepEqual(fake.writes().map((w) => w.body.name), ["High", "Low"]);
});

test("overwriting a base policy sends its settings but not its name or enabled flag", async () => {
  seed();
  policies.src.push({ id: "sb", name: "Base Policy", type: "web-control", enabled: true, priority: 0, settings });
  fake.reset();
  // As the live API answers when either field is present.
  fake.on(DST, "PATCH", "/endpoint/v1/policies/d0", (req) =>
    "name" in req.body || "enabled" in req.body
      ? { status: 400, body: { error: "badRequest", message: "Cannot update the enabled of a base policy. Cannot update the name of a base policy." } }
      : { body: { id: "d0", name: "Base Policy", priority: 0, ...req.body } });
  const [res] = await migratePolicies({ policyIds: ["sb"], overwrite: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.action, "overwrite");
  const [patch] = fake.writes();
  assert.equal(patch.path, "/endpoint/v1/policies/d0");
  assert.deepEqual(Object.keys(patch.body).sort(), ["settings", "type"].concat("enforced" in patch.body ? ["enforced"] : []).sort());
  assert.deepEqual(patch.body.settings, settings);
});
