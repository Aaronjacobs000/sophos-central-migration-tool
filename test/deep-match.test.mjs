// The Policies page's deep match: priority is not a difference, and a web
// profile compares by name, not by each tenant's ID for it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { computeDeepMatch, compareRouter } = await import("../backend/dist/routes/compare.js");
const preloader = await import("../backend/dist/services/preloader.js");
const http = await startHttp([compareRouter]);
after(() => http.close());

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

// The route caches the deep match. A write from Compare reloads the
// destination's policies, and the Policies page must then compare again, not
// show the count from before the write (seen live 26/09/2026).
test("reloading policies drops the cached deep match", async () => {
  const pair = (dstValue) => {
    policies.src = [{ id: "s1", name: "Clone", type: "web-control", enabled: true, priority: 3, settings }];
    policies.dst = [{ id: "d1", name: "Clone", type: "web-control", enabled: true, priority: 1, settings: { "endpoint.web-control.web-filtering.enabled": { value: dstValue } } }];
  };
  const status = async () => statusOf((await http.get("/api/compare/policies/deep")).body, "Clone").status;

  pair(false);
  assert.equal(await status(), "differ");
  pair(true);
  assert.equal(await status(), "differ", "served from the cache");
  await preloader.refreshSection("dest", "policies");
  assert.equal(await status(), "match");

  pair(false);
  preloader.startPreload();
  assert.equal(await status(), "differ", "a full reload drops it too");
});

test("a deep match that was running when the cache was dropped is not cached", async () => {
  policies.src = [{ id: "s1", name: "Clone", type: "web-control", enabled: true, priority: 3, settings }];
  policies.dst = [{ id: "d1", name: "Clone", type: "web-control", enabled: true, priority: 1, settings }];
  // Hold the running match's destination list until the reload has happened.
  let release;
  let gate = new Promise((r) => { release = r; });
  fake.on(DST, "GET", "/endpoint/v1/policies", async (req) => {
    const g = gate;
    gate = null;
    if (g) await g;
    return page(policies.dst, req.query);
  });
  fake.reset();
  const running = http.get("/api/compare/policies/deep?refresh=true");
  while (!fake.calls.some((c) => c.method === "GET" && c.path === "/endpoint/v1/policies" && c.tenant === "dst")) {
    await new Promise((r) => setTimeout(r, 1));
  }
  await preloader.refreshSection("dest", "policies");
  release();
  assert.equal(statusOf((await running).body, "Clone").status, "match");

  policies.dst[0].settings = { "endpoint.web-control.web-filtering.enabled": { value: false } };
  assert.equal(statusOf((await http.get("/api/compare/policies/deep")).body, "Clone").status, "differ");
});
