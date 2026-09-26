// API #3: web filtering site lists and profiles, and the web profile ID
// remap on policy clone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { copyWebFilters } = await import("../backend/dist/services/web-filter-copier.js");
const { migratePolicies } = await import("../backend/dist/services/policy-migrator.js");

const db = { src: {}, dst: {} };
function seed() {
  db.src.lists = [
    { id: "sl-a", name: "Allowed partners", description: "Partner portals", numberOfSites: 2 },
    { id: "sl-b", name: "Blocked shops", numberOfSites: 1 },
    { id: "sl-c", name: "Empty list", numberOfSites: 0 },
    { id: "sl-d", name: "Not selected", numberOfSites: 1 },
  ];
  db.src.sites = {
    "sl-a": [{ id: "s1", site: "partner1.example.test" }, { id: "s2", site: "partner2.example.test" }],
    "sl-b": [{ id: "s3", site: "shop.example.test" }],
    "sl-c": [],
    "sl-d": [{ id: "s4", site: "other.example.test" }],
  };
  db.dst.lists = [{ id: "dl-b", name: "BLOCKED SHOPS", numberOfSites: 1 }];
  db.src.profiles = [
    {
      id: "wp-1", name: "Staff", description: "Default staff profile",
      consumers: [{ type: "computerWebControlPolicy", id: "pol-src-1" }],
      filterByCategory: true, categoryGroupActions: [{ name: "Adult", action: "block" }],
      filterBySiteList: true,
      siteListActions: [
        { id: "sl-a", action: "allow", priority: 3 },
        { id: "sl-b", action: "block", priority: 2 },
        { id: "sl-d", action: "warn", priority: 1 },
      ],
    },
    { id: "wp-2", name: "Kiosk", preset: "strict" },
  ];
  db.dst.profiles = [{ id: "dp-2", name: "kiosk" }];
}

for (const [key, tenant] of [["src", SRC], ["dst", DST]]) {
  fake.on(tenant, "GET", "/web-filters/v1/site-lists", (req) => page(db[key].lists, req.query));
  fake.on(tenant, "GET", /^\/web-filters\/v1\/site-lists\/[^/]+\/sites$/, (req) => page(db[key].sites?.[req.path.split("/")[4]] ?? [], req.query));
  fake.on(tenant, "GET", "/web-filters/v1/profiles", (req) => page(db[key].profiles.map(({ id, name, consumers }) => ({ id, name, consumers })), req.query));
  fake.on(tenant, "GET", /^\/web-filters\/v1\/profiles\/[^/]+$/, (req) => {
    const p = db[key].profiles.find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound" } };
  });
  fake.on(tenant, "POST", "/web-filters/v1/site-lists", (req) => {
    const created = { id: fake.nextId("dl"), ...req.body };
    db[key].lists.push(created);
    return { status: 201, body: created };
  });
  fake.on(tenant, "POST", "/web-filters/v1/profiles", (req) => {
    const created = { id: fake.nextId("dp"), ...req.body };
    db[key].profiles.push(created);
    return { status: 201, body: created };
  });
}

test("dry run: plans site lists and profiles, maps rules, writes nothing", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await copyWebFilters({ siteListIds: ["sl-a", "sl-b", "sl-c"], profileIds: ["wp-1", "wp-2"], dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.equal((await readAudit(root)).length, before);
  const r = (id) => results.find((x) => x.sourceId === id);
  assert.equal(r("sl-a").action, "dry-run-create");
  assert.equal(r("sl-a").note, "2 sites");
  assert.equal(r("sl-b").action, "skip-exists", "names match without case");
  assert.equal(r("sl-c").ok, false, "empty lists cannot be created");
  assert.equal(r("wp-2").action, "skip-exists");
  const wp1 = r("wp-1");
  assert.equal(wp1.action, "dry-run-create");
  assert.ok(wp1.adjustments.some((a) => /would map to the copy made in this run/.test(a)));
  assert.ok(wp1.adjustments.some((a) => /dropped the "warn" rule for site list "Not selected"/.test(a)));
});

test("real copy: creates lists then a profile whose rules point at destination lists", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await copyWebFilters({ siteListIds: ["sl-a", "sl-b"], profileIds: ["wp-1", "wp-2"] });
  const writes = fake.writes();
  assert.ok(writes.every((w) => w.tenant === "dst"));
  const listPosts = writes.filter((w) => w.path === "/web-filters/v1/site-lists");
  assert.equal(listPosts.length, 1);
  assert.deepEqual(listPosts[0].body, { name: "Allowed partners", sites: ["partner1.example.test", "partner2.example.test"], description: "Partner portals" });
  const newListId = results.find((x) => x.sourceId === "sl-a").destId;

  const profilePosts = writes.filter((w) => w.path === "/web-filters/v1/profiles");
  assert.equal(profilePosts.length, 1, "Kiosk already exists by name");
  const body = profilePosts[0].body;
  assert.equal(body.name, "Staff");
  assert.equal(body.consumers, undefined, "policy links are not copied");
  assert.deepEqual(body.categoryGroupActions, [{ name: "Adult", action: "block" }]);
  assert.deepEqual(body.siteListActions, [
    { id: newListId, action: "allow", priority: 3 },
    { id: "dl-b", action: "block", priority: 2 },
  ]);
  const wp1 = results.find((x) => x.sourceId === "wp-1");
  assert.ok(wp1.adjustments.some((a) => /Not selected/.test(a)));

  const entries = (await readAudit(root)).slice(before);
  assert.deepEqual(entries.map((e) => e.resource), ["web-filter-site-list", "web-filter-profile"]);
  assert.ok(entries.every((e) => e.ok && e.side === "dest"));
});

// ---- policy clone: web profile ID remap ----

const PROFILE_KEY = "endpoint.web-control.web-profile-id";
const SCHEDULE_KEY = "endpoint.web-control.web-profile-schedules";
const policies = { src: [], dst: [] };
for (const [key, tenant] of [["src", SRC], ["dst", DST]]) {
  fake.on(tenant, "GET", "/endpoint/v1/policies", (req) => page(policies[key], req.query));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
    const p = policies[key].find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound" } };
  });
  fake.on(tenant, "POST", "/endpoint/v1/policies", (req) => ({ status: 201, body: { id: fake.nextId("pol"), ...req.body } }));
}

function seedPolicies() {
  seed();
  db.dst.profiles.push({ id: "dp-staff", name: "STAFF" });
  policies.src = [
    { id: "pol-1", name: "Staff browsing", type: "web-control", enabled: true, priority: 1, settings: {
      [PROFILE_KEY]: { value: "wp-1" },
      [SCHEDULE_KEY]: { value: [{ profileId: "wp-1", days: ["monday"] }, { profileId: "wp-2", days: ["sunday"] }] },
      "endpoint.web-control.web-filtering.enabled": { value: true },
    } },
    { id: "pol-2", name: "Lab browsing", type: "web-control", enabled: true, priority: 2, settings: {
      [PROFILE_KEY]: { value: "wp-missing" },
    } },
  ];
  policies.dst = [];
}

test("policy clone: maps the web profile ID and schedule to same-named destination profiles", async () => {
  seedPolicies();
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["pol-1"] });
  assert.equal(res.ok, true);
  const post = fake.writes().find((w) => w.path === "/endpoint/v1/policies");
  assert.equal(post.body.settings[PROFILE_KEY].value, "dp-staff");
  assert.deepEqual(post.body.settings[SCHEDULE_KEY].value, [{ profileId: "dp-staff", days: ["monday"] }, { profileId: "dp-2", days: ["sunday"] }]);
  assert.ok(res.adjustments.some((a) => /mapped web profile "Staff"/.test(a)));
});

test("policy clone dry run: reports the remap and writes nothing", async () => {
  seedPolicies();
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["pol-1"], dryRun: true });
  assert.equal(res.action, "dry-run-create");
  assert.equal(fake.writes().length, 0);
  assert.ok(res.adjustments.some((a) => /mapped web profile "Staff"/.test(a)));
});

// The live API refuses a web control policy whose profile ID is left out
// ("Invalid Web Profile Id", 26/09/2026), so the policy is not sent at all.
test("policy clone: a profile missing on the destination stops the policy and says which to copy", async () => {
  seedPolicies();
  db.dst.profiles = db.dst.profiles.filter((p) => p.id !== "dp-staff");
  fake.reset();
  const audited = (await readAudit(root)).length;
  const res = await migratePolicies({ policyIds: ["pol-1", "pol-2"] });
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(res.map((r) => [r.ok, r.action]), [[false, "create"], [false, "create"]]);
  assert.match(res[0].error, /web profile "Staff" is not on the destination: copy it on the Web filtering page first/);
  assert.match(res[1].error, /web profile wp-missing was not found on the source/);
  for (const r of res) assert.doesNotMatch(r.error, /[\u2013\u2014]/);
  assert.equal((await readAudit(root)).length, audited, "nothing written, nothing audited");

  const [dry] = await migratePolicies({ policyIds: ["pol-1"], dryRun: true });
  assert.deepEqual([dry.ok, dry.action], [false, "dry-run-create"]);
  assert.match(dry.error, /"Staff" is not on the destination/);
});

test("policy clone: a schedule profile missing on the destination drops the schedule only", async () => {
  seedPolicies();
  db.dst.profiles = db.dst.profiles.filter((p) => p.id !== "dp-2");
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["pol-1"] });
  assert.equal(res.ok, true);
  const post = fake.writes().find((w) => w.path === "/endpoint/v1/policies");
  assert.equal(post.body.settings[PROFILE_KEY].value, "dp-staff");
  assert.equal(post.body.settings[SCHEDULE_KEY], undefined);
  assert.ok(res.adjustments.some((a) => /dropped the web profile schedule: "Kiosk" is not on the destination/.test(a)));
});

test("policy clone: policies without a web profile make no profile lookups", async () => {
  seedPolicies();
  policies.src.push({ id: "pol-3", name: "Base TP", type: "threat-protection", settings: { "endpoint.threat-protection.amsi.enabled": { value: true } } });
  // As the live API returns it for a policy that does not use web profiles.
  policies.src.push({ id: "pol-4", name: "Legacy web", type: "web-control", settings: { [PROFILE_KEY]: { value: "" }, [SCHEDULE_KEY]: { value: [] } } });
  fake.reset();
  const res = await migratePolicies({ policyIds: ["pol-3", "pol-4"], dryRun: true });
  assert.equal(res[1].adjustments, undefined);
  assert.equal(fake.calls.filter((c) => c.path === "/web-filters/v1/profiles").length, 0);
});
