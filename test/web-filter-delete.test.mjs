// Deleting web filtering site lists and profiles on the destination: the
// undo for a copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { deleteWebFilters } = await import("../backend/dist/services/web-filter-deleter.js");

const db = {};
function seed() {
  db.lists = [
    { id: "dl-1", name: "Partners", usedBy: [{ id: "dp-1", name: "Staff" }] },
    { id: "dl-2", name: "Shops", usedBy: [{ id: "dp-2", name: "Kiosk" }] },
    { id: "dl-3", name: "Unused" },
  ];
  db.profiles = [
    { id: "dp-1", name: "Staff" },
    { id: "dp-2", name: "Kiosk", consumers: [{ type: "computerWebControlPolicy", id: "pol-9" }] },
  ];
  db.policies = [{ id: "pol-9", name: "Kiosk browsing", type: "web-control" }];
  db.failDelete = new Set();
}

fake.on(DST, "GET", "/web-filters/v1/site-lists", (req) => page(db.lists, req.query));
fake.on(DST, "GET", "/web-filters/v1/profiles", (req) => page(db.profiles, req.query));
fake.on(DST, "GET", "/endpoint/v1/policies", (req) => page(db.policies, req.query));
fake.on(DST, "DELETE", /^\/web-filters\/v1\/(site-lists|profiles)\/[^/]+$/, (req) => {
  const [, , , kind, id] = req.path.split("/");
  if (db.failDelete.has(id)) return { status: 500, body: { error: "InternalError", message: "boom" } };
  if (kind === "profiles") {
    db.profiles = db.profiles.filter((p) => p.id !== id);
    for (const l of db.lists) l.usedBy = (l.usedBy ?? []).filter((u) => u.id !== id);
  } else {
    db.lists = db.lists.filter((l) => l.id !== id);
  }
  return { status: 200, body: { deleted: true } };
});
// The source is never touched by a delete.
fake.on(SRC, "DELETE", /.*/, () => ({ status: 500, body: { error: "wrong tenant" } }));

const byId = (results, id) => results.find((r) => r.id === id);

test("dry run: plans deletes, refuses items in use, writes nothing", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await deleteWebFilters({ siteListIds: ["dl-1", "dl-2", "dl-3"], profileIds: ["dp-1", "dp-2"], dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.equal((await readAudit(root)).length, before, "a dry run writes no audit entries");
  assert.equal(byId(results, "dp-1").action, "dry-run-delete");
  assert.equal(byId(results, "dp-1").ok, true);
  assert.equal(byId(results, "dl-1").ok, true, "its only profile is deleted in the same run");
  assert.equal(byId(results, "dl-3").ok, true);
  const kiosk = byId(results, "dp-2");
  assert.equal(kiosk.ok, false);
  assert.match(kiosk.error, /in use by policy "Kiosk browsing"/);
  const shops = byId(results, "dl-2");
  assert.equal(shops.ok, false, "its profile is in use, so it stays");
  assert.match(shops.error, /in use by profile "Kiosk"/);
  for (const r of results) if (r.error) assert.doesNotMatch(r.error, /[\u2013\u2014]/);
});

test("real delete: profiles first, then their lists; items in use are left alone", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await deleteWebFilters({ siteListIds: ["dl-1", "dl-2", "dl-3"], profileIds: ["dp-1", "dp-2"] });
  const deletes = fake.writes().map((w) => `${w.tenant} ${w.method} ${w.path}`);
  assert.deepEqual(deletes, [
    "dst DELETE /web-filters/v1/profiles/dp-1",
    "dst DELETE /web-filters/v1/site-lists/dl-1",
    "dst DELETE /web-filters/v1/site-lists/dl-3",
  ]);
  assert.deepEqual(results.filter((r) => r.ok).map((r) => r.id).sort(), ["dl-1", "dl-3", "dp-1"]);
  assert.ok(results.filter((r) => r.ok).every((r) => r.action === "delete"));
  const entries = (await readAudit(root)).slice(before);
  assert.deepEqual(entries.map((e) => `${e.action} ${e.resource} ${e.resourceId} ${e.ok}`), [
    "delete web-filter-profile dp-1 true",
    "delete web-filter-site-list dl-1 true",
    "delete web-filter-site-list dl-3 true",
  ]);
  assert.ok(entries.every((e) => e.side === "dest" && e.tenantId === DST.tenantId));
  assert.equal(entries[0].detail.name, "Staff");
});

test("a failed delete is reported and audited, and keeps its lists in use", async () => {
  seed();
  db.failDelete.add("dp-1");
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await deleteWebFilters({ siteListIds: ["dl-1"], profileIds: ["dp-1"] });
  assert.equal(byId(results, "dp-1").ok, false);
  assert.match(byId(results, "dp-1").error, /500/);
  assert.equal(byId(results, "dl-1").ok, false);
  assert.match(byId(results, "dl-1").error, /in use by profile "Staff"/);
  assert.equal(fake.writes().filter((w) => w.path.includes("/site-lists/")).length, 0);
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ok, false);
  assert.equal(entries[0].resource, "web-filter-profile");
});

test("an ID that is not on the destination is reported, not sent", async () => {
  seed();
  fake.reset();
  const results = await deleteWebFilters({ siteListIds: ["nope"], profileIds: ["gone"] });
  assert.equal(fake.writes().length, 0);
  assert.ok(results.every((r) => !r.ok && r.error === "not on the destination"));
});
