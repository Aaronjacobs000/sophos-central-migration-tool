// The Policies page's deep match: priority is not a difference, and a web
// profile compares by name, not by each tenant's ID for it.
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

// ---- web profiles: compared by name, not by each tenant's ID ----

const PROFILE_KEY = "endpoint.web-control.web-profile-id";
const SCHEDULE_KEY = "endpoint.web-control.web-profile-schedules";
const profiles = { src: [], dst: [] };
const profileLookupFails = { src: false, dst: false };
for (const [tenant, side] of [[SRC, "src"], [DST, "dst"]]) {
  fake.on(tenant, "GET", "/web-filters/v1/profiles", (req) =>
    profileLookupFails[side]
      ? { status: 403, body: { error: "Forbidden", message: "no web filtering access" } }
      : page(profiles[side], req.query));
}

const webPolicy = (id, name, profileId, schedule = []) => ({
  id, name, type: "web-control", enabled: true, enforced: false, priority: 1,
  settings: { ...settings, [PROFILE_KEY]: { value: profileId }, [SCHEDULE_KEY]: { value: schedule } },
});

function seedProfiles() {
  profiles.src = [{ id: "wp-staff", name: "Staff" }, { id: "wp-kiosk", name: "Kiosk" }];
  // Matched the way the policy migrator maps them: trimmed, any case.
  profiles.dst = [{ id: "dp-staff", name: "Staff" }, { id: "dp-kiosk", name: "kiosk " }];
  profileLookupFails.src = profileLookupFails.dst = false;
}

test("web profile: the same profile name under a different ID matches", async () => {
  seedProfiles();
  policies.src = [webPolicy("s1", "Web", "wp-staff", [{ profileId: "wp-kiosk", days: ["sunday"] }])];
  policies.dst = [webPolicy("d1", "Web", "dp-staff", [{ profileId: "dp-kiosk", days: ["sunday"] }])];
  const m = statusOf(await computeDeepMatch(), "Web");
  assert.deepEqual([m.status, m.diffCount], ["match", 0]);
});

test("web profile: a different profile is a change", async () => {
  seedProfiles();
  policies.src = [
    webPolicy("s1", "Web", "wp-staff"),
    webPolicy("s2", "Schedule", "wp-staff", [{ profileId: "wp-kiosk", days: ["sunday"] }]),
  ];
  policies.dst = [
    webPolicy("d1", "Web", "dp-kiosk"),
    webPolicy("d2", "Schedule", "dp-staff", [{ profileId: "dp-staff", days: ["sunday"] }]),
  ];
  const res = await computeDeepMatch();
  assert.deepEqual([statusOf(res, "Web").status, statusOf(res, "Web").diffCount], ["differ", 1]);
  assert.deepEqual([statusOf(res, "Schedule").status, statusOf(res, "Schedule").diffCount], ["differ", 1]);
});

test("web profile: an ID that can't be resolved to a name is a change", async () => {
  seedProfiles();
  // Not in the destination's profile list.
  policies.src = [webPolicy("s1", "Web", "wp-staff")];
  policies.dst = [webPolicy("d1", "Web", "dp-deleted")];
  let m = statusOf(await computeDeepMatch(), "Web");
  assert.deepEqual([m.status, m.diffCount], ["differ", 1]);

  // Not in the source's profile list.
  policies.src = [webPolicy("s1", "Web", "wp-deleted")];
  policies.dst = [webPolicy("d1", "Web", "dp-staff")];
  m = statusOf(await computeDeepMatch(), "Web");
  assert.deepEqual([m.status, m.diffCount], ["differ", 1]);

  // The destination's profile lookup fails.
  policies.src = [webPolicy("s1", "Web", "wp-staff")];
  profileLookupFails.dst = true;
  m = statusOf(await computeDeepMatch(), "Web");
  assert.deepEqual([m.status, m.diffCount], ["differ", 1]);
});

test("web profile: policies that name no profile make no profile lookups", async () => {
  seedProfiles();
  // As the live API returns them for a policy that does not use web profiles.
  policies.src = [webPolicy("s1", "Web", "")];
  policies.dst = [webPolicy("d1", "Web", "")];
  fake.reset();
  const m = statusOf(await computeDeepMatch(), "Web");
  assert.deepEqual([m.status, m.diffCount], ["match", 0]);
  assert.equal(fake.calls.filter((c) => c.path === "/web-filters/v1/profiles").length, 0);
});
