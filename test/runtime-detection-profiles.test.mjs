// Linux runtime detection policies name their detection profile by ID and
// version, and both are each tenant's own. The clone maps the profile by name
// to the destination's latest version, or stops and names the profile when the
// destination has none; Compare and the deep match show it by name.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { migratePolicies } = await import("../backend/dist/services/policy-migrator.js");
const { computeDeepMatch, compareRouter } = await import("../backend/dist/routes/compare.js");
const http = await startHttp([compareRouter]);
after(() => http.close());

const ID_KEY = "endpoint.server-linux-runtime-detection.profile-id";
const VERSION_KEY = "endpoint.server-linux-runtime-detection.profile-version";
const ENABLED_KEY = "endpoint.server-linux-runtime-detection.enabled";
const PROFILES = "/cloud-security/v1/profiles";

const policies = { src: [], dst: [] };
const profiles = { src: [], dst: [] };
const lookupFails = { src: false, dst: false };
for (const [tenant, side] of [[SRC, "src"], [DST, "dst"]]) {
  fake.on(tenant, "GET", "/endpoint/v1/policies", (req) => page(policies[side], req.query));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
    const p = policies[side].find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound", message: "no such policy" } };
  });
  fake.on(tenant, "POST", "/endpoint/v1/policies", (req) => ({ status: 201, body: { id: fake.nextId("pol"), ...req.body } }));
  fake.on(tenant, "GET", PROFILES, (req) =>
    lookupFails[side]
      ? { status: 403, body: { error: "Forbidden", message: "no runtime detection access" } }
      : page(profiles[side], req.query));
}

const lrdPolicy = (id, profileId, version = 1, name = "Linux servers") => ({
  id, name, type: "server-linux-runtime-detection", enabled: true, enforced: false, priority: 1,
  settings: {
    [ENABLED_KEY]: { value: true, recommendedValue: true },
    [ID_KEY]: { value: profileId },
    [VERSION_KEY]: { value: version },
  },
});

function seed() {
  profiles.src = [{ id: "rp-web", name: "Web servers", version: 1 }, { id: "rp-db", name: "Databases", version: 3 }];
  // Matched trimmed and in any case. The destination counts its own versions.
  profiles.dst = [{ id: "dp-web", name: "WEB SERVERS ", version: 4 }];
  lookupFails.src = lookupFails.dst = false;
  policies.src = [lrdPolicy("s1", "rp-web"), lrdPolicy("s2", "rp-db", 3, "Database servers"), lrdPolicy("s3", "rp-gone", 1, "Old servers")];
  policies.dst = [];
}

const profileLookups = () => fake.calls.filter((c) => c.path === PROFILES).length;

test("clone: maps the profile by name to the destination's latest version", async () => {
  seed();
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["s1"] });
  assert.equal(res.ok, true);
  const post = fake.writes().find((w) => w.path === "/endpoint/v1/policies");
  assert.equal(post.body.settings[ID_KEY].value, "dp-web");
  assert.equal(post.body.settings[VERSION_KEY].value, 4, "the source's version 1 means nothing on the destination");
  assert.equal(post.body.settings[ENABLED_KEY].value, true);
  assert.deepEqual(res.adjustments, [
    'mapped Linux runtime detection profile "Web servers" to the destination profile with the same name, at its latest version (4)',
  ]);
});

test("clone: a profile missing on the destination stops the policy and names it", async () => {
  seed();
  fake.reset();
  const audited = (await readAudit(root)).length;
  const res = await migratePolicies({ policyIds: ["s2", "s3"] });
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(res.map((r) => [r.ok, r.action]), [[false, "create"], [false, "create"]]);
  assert.equal(res[0].error, 'Linux runtime detection profile "Databases" is not on the destination: create a profile with that name there first, then clone again');
  assert.match(res[1].error, /profile rp-gone was not found on the source/);
  for (const r of res) assert.doesNotMatch(r.error, /[–—]/);
  assert.equal((await readAudit(root)).length, audited, "nothing written, nothing audited");

  const [dry] = await migratePolicies({ policyIds: ["s2"], dryRun: true });
  assert.deepEqual([dry.ok, dry.action], [false, "dry-run-create"]);
  assert.match(dry.error, /"Databases" is not on the destination/);
});

test("clone: a policy with no profile is sent as it is, with no profile lookups", async () => {
  seed();
  // As the live API returns a base policy, or one with detection off.
  policies.src = [lrdPolicy("s4", "", 1, "No profile")];
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["s4"] });
  assert.equal(res.ok, true);
  assert.equal(res.adjustments, undefined);
  assert.equal(profileLookups(), 0);
  const post = fake.writes().find((w) => w.path === "/endpoint/v1/policies");
  assert.deepEqual([post.body.settings[ID_KEY].value, post.body.settings[VERSION_KEY].value], ["", 1]);
});

test("clone: a failed profile lookup sends the ID unchanged and says so", async () => {
  seed();
  lookupFails.dst = true;
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["s1"], dryRun: true });
  assert.equal(res.ok, true);
  assert.match(res.adjustments[0], /could not look up Linux runtime detection profiles, so the profile ID was sent unchanged/);
});

// ---- Compare and the deep match ----

const compare = async (s, d) => (await http.get(`/api/compare/policies/${s}/${d}`)).body;
const statusOf = (res, name) => res.matches.find((m) => m.name === name);

test("compare: a correct clone matches, shown by profile name and latest version", async () => {
  seed();
  policies.src = [lrdPolicy("s1", "rp-web", 1)];
  policies.dst = [lrdPolicy("d1", "dp-web", 4)];
  const res = await compare("s1", "d1");
  assert.deepEqual(res.summary, { added: 0, removed: 0, changed: 0 });
  // One name for the profile on both sides, whatever its case or spaces there.
  assert.equal(res.settings.source[ID_KEY].value, "Web servers");
  assert.equal(res.settings.dest[ID_KEY].value, "Web servers");
  assert.equal(res.settings.source[VERSION_KEY].value, "latest");
  assert.equal(res.settings.dest[VERSION_KEY].value, "latest");
  // The raw policies still carry each tenant's IDs.
  assert.equal(res.destPolicy.settings[ID_KEY].value, "dp-web");

  const m = statusOf(await computeDeepMatch(), "Linux servers");
  assert.deepEqual([m.status, m.diffCount], ["match", 0]);
});

test("compare: a different profile, an older version or an unknown ID is a change", async () => {
  seed();
  profiles.dst.push({ id: "dp-db", name: "Databases", version: 1 });
  policies.src = [lrdPolicy("s1", "rp-web", 1)];

  policies.dst = [lrdPolicy("d1", "dp-db", 1)];
  let res = await compare("s1", "d1");
  assert.equal(res.summary.changed, 1, "the version is each profile's latest, so only the name differs");
  assert.deepEqual([res.settings.source[ID_KEY].value, res.settings.dest[ID_KEY].value], ["Web servers", "Databases"]);

  policies.dst = [lrdPolicy("d1", "dp-web", 2)];
  res = await compare("s1", "d1");
  assert.equal(res.summary.changed, 1);
  assert.deepEqual([res.settings.source[VERSION_KEY].value, res.settings.dest[VERSION_KEY].value], ["latest", 2]);

  policies.dst = [lrdPolicy("d1", "dp-deleted", 4)];
  res = await compare("s1", "d1");
  assert.equal(res.settings.dest[ID_KEY].value, "dp-deleted");
  const m = statusOf(await computeDeepMatch(), "Linux servers");
  assert.equal(m.status, "differ");
});

test("compare: policies that name no profile make no profile lookups", async () => {
  seed();
  policies.src = [lrdPolicy("s1", "", 1)];
  policies.dst = [lrdPolicy("d1", "", 1)];
  fake.reset();
  const res = await compare("s1", "d1");
  assert.deepEqual(res.summary, { added: 0, removed: 0, changed: 0 });
  const m = statusOf(await computeDeepMatch(), "Linux servers");
  assert.deepEqual([m.status, m.diffCount], ["match", 0]);
  assert.equal(profileLookups(), 0);
});
