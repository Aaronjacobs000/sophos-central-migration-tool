// The single policy Compare page: a web profile compares by name, not by each
// tenant's ID for it, and the page shows the names the server sends.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { compareRouter } = await import("../backend/dist/routes/compare.js");
const { flattenForCompare, summarizeEntries } = await import("../frontend/js/diff-view.js");
const http = await startHttp([compareRouter]);
after(() => http.close());

const PROFILE_KEY = "endpoint.web-control.web-profile-id";
const SCHEDULE_KEY = "endpoint.web-control.web-profile-schedules";
const policies = { src: [], dst: [] };
const profiles = { src: [], dst: [] };
const profileLookupFails = { src: false, dst: false };
for (const [tenant, side] of [[SRC, "src"], [DST, "dst"]]) {
  fake.on(tenant, "GET", "/endpoint/v1/policies", (req) => page(policies[side], req.query));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
    const p = policies[side].find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound", message: "no such policy" } };
  });
  fake.on(tenant, "GET", "/web-filters/v1/profiles", (req) =>
    profileLookupFails[side]
      ? { status: 403, body: { error: "Forbidden", message: "no web filtering access" } }
      : page(profiles[side], req.query));
}

const webPolicy = (id, profileId, schedule = []) => ({
  id, name: "Web", type: "web-control", enabled: true, enforced: false, priority: 1,
  settings: {
    "endpoint.web-control.web-filtering.enabled": { value: true },
    [PROFILE_KEY]: { value: profileId },
    [SCHEDULE_KEY]: { value: schedule },
  },
});

function seed(srcPolicy, dstPolicy) {
  profiles.src = [{ id: "wp-staff", name: "Staff" }, { id: "wp-kiosk", name: "Kiosk" }];
  // Matched the way the policy migrator maps them: trimmed, any case.
  profiles.dst = [{ id: "dp-staff", name: "Staff" }, { id: "dp-kiosk", name: "kiosk " }];
  profileLookupFails.src = profileLookupFails.dst = false;
  policies.src = [srcPolicy];
  policies.dst = [dstPolicy];
}

const compare = async () => (await http.get("/api/compare/policies/s1/d1")).body;
const profileRow = (res) => flattenForCompare(res.settings.source, res.settings.dest)
  .find((e) => e.path[0] === PROFILE_KEY);

test("a correct clone matches, and the page shows profile names", async () => {
  seed(
    webPolicy("s1", "wp-staff", [{ webProfileId: "wp-kiosk", days: ["sunday"] }]),
    webPolicy("d1", "dp-staff", [{ webProfileId: "dp-kiosk", days: ["sunday"] }]),
  );
  const res = await compare();
  assert.deepEqual(res.summary, { added: 0, removed: 0, changed: 0 });
  assert.deepEqual(res.changes, []);
  assert.equal(res.settings.source[PROFILE_KEY].value, "Staff");
  assert.equal(res.settings.dest[PROFILE_KEY].value, "Staff");
  // The same profile reads the same on both sides, whatever its case or spaces there.
  assert.deepEqual(res.settings.dest[SCHEDULE_KEY].value, [{ webProfileId: "Kiosk", days: ["sunday"] }]);
  const entries = flattenForCompare(res.settings.source, res.settings.dest);
  assert.equal(summarizeEntries(entries).differ, 0);
  assert.equal(profileRow(res).status, "match");
  // The raw policies still carry each tenant's IDs.
  assert.equal(res.sourcePolicy.settings[PROFILE_KEY].value, "wp-staff");
  assert.equal(res.destPolicy.settings[PROFILE_KEY].value, "dp-staff");
});

test("a different profile is a change, shown by name", async () => {
  seed(webPolicy("s1", "wp-staff"), webPolicy("d1", "dp-kiosk"));
  const res = await compare();
  assert.deepEqual(res.summary, { added: 0, removed: 0, changed: 1 });
  const row = profileRow(res);
  assert.deepEqual([row.source, row.dest, row.status], ["Staff", "Kiosk", "differ"]);
});

test("an unknown ID or a failed lookup stays raw and is a change", async () => {
  seed(webPolicy("s1", "wp-staff"), webPolicy("d1", "dp-deleted"));
  let res = await compare();
  assert.equal(res.summary.changed, 1);
  let row = profileRow(res);
  assert.deepEqual([row.source, row.dest, row.status], ["Staff", "dp-deleted", "differ"]);

  seed(webPolicy("s1", "wp-staff"), webPolicy("d1", "dp-staff"));
  profileLookupFails.dst = true;
  res = await compare();
  assert.equal(res.summary.changed, 1);
  row = profileRow(res);
  assert.deepEqual([row.source, row.dest, row.status], ["Staff", "dp-staff", "differ"]);
});

test("policies that name no profile make no profile lookups", async () => {
  seed(webPolicy("s1", ""), webPolicy("d1", ""));
  fake.reset();
  const res = await compare();
  assert.deepEqual(res.summary, { added: 0, removed: 0, changed: 0 });
  assert.equal(fake.calls.filter((c) => c.path === "/web-filters/v1/profiles").length, 0);
});

test("the Compare page draws the server's settings, not the raw policies", async () => {
  const js = await readFile(new URL("../frontend/js/page-policy-compare.js", import.meta.url), "utf8");
  const call = js.slice(js.indexOf("state.entries = flattenForCompare("), js.indexOf("renderHeader();"));
  assert.match(call, /res\.settings\?\.source \?\?/);
  assert.match(call, /res\.settings\?\.dest \?\?/);
});
