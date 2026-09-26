// Check-in after a move: Sophos says "succeeded" at the handover, the device arrives minutes later under its new ID.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { checkInFor, awaitingCheckIn, CHECK_IN_MARGIN_MS } = await import("../backend/dist/services/device-check-in.js");
const { pollJob } = await import("../backend/dist/services/device-migrator.js");
const { getJob } = await import("../backend/dist/services/migration-store.js");

const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-00000000000a";
const STALE = "00000000-0000-4000-8000-00000000000b";
const at = (min) => new Date(Date.UTC(2026, 8, 25, 22, 34) + min * 60e3).toISOString();

// Shapes measured on 26/09/2026: the new record is registered at the handover with lastSeenAt equal to
// registeredAt; the stale record is the same hostname left behind by an earlier move.
const handedOver = { id: OLD, status: "succeeded", newId: NEW, migratedAt: at(0.1) };
const registered = { id: NEW, hostname: "WIN10", registeredAt: at(0.08), lastSeenAt: at(0.08) };
const stale = { id: STALE, hostname: "WIN10", registeredAt: at(-60 * 24 * 50), lastSeenAt: at(1) };

test("waiting: handed over, the new record has not been seen since it was registered", () => {
  assert.deepEqual(checkInFor(handedOver, [registered]), { state: "waiting", newId: NEW, handedOverAt: at(0.1) });
  assert.equal(checkInFor(handedOver, []).state, "waiting", "no record yet");
  assert.equal(checkInFor(handedOver, [{ ...registered, lastSeenAt: new Date(Date.parse(registered.registeredAt) + CHECK_IN_MARGIN_MS / 2).toISOString() }]).state, "waiting", "inside the margin");
});

test("checked in: the new record's last-seen time passes its registration", () => {
  const seen = { ...registered, lastSeenAt: at(24.8) };
  assert.deepEqual(checkInFor(handedOver, [seen]), { state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8) });
});

test("a stale record with the same hostname is never matched", () => {
  // The stale record was seen after the handover (another device, or a clock), but it is not the new ID.
  assert.equal(checkInFor(handedOver, [stale]).state, "waiting");
  assert.equal(checkInFor(handedOver, [stale, registered]).state, "waiting");
  const c = checkInFor(handedOver, [stale, { ...registered, lastSeenAt: at(25) }]);
  assert.equal(c.state, "checked-in");
  assert.equal(c.newId, NEW);
  assert.equal(c.checkedInAt, at(25));
});

test("not handed over, failed, and a saved check-in that later polls do not move", () => {
  assert.deepEqual(checkInFor({ id: OLD, status: "pending" }, [registered]), { state: "not-moved" });
  assert.deepEqual(checkInFor({ id: OLD, status: "failed" }, []), { state: "move-failed" });
  assert.deepEqual(checkInFor(undefined, []), { state: "not-moved" });
  const first = { state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8) };
  assert.equal(checkInFor(handedOver, [{ ...registered, lastSeenAt: at(90) }], first), first);
  assert.equal(checkInFor(undefined, [], first), first, "a failed poll keeps what was known");
});

// --- through pollJob against the fake API ---

let jobEndpoints = [];
let destRecords = [];
for (const tenant of [SRC, DST]) {
  fake.on(tenant, "GET", /^\/endpoint\/v1\/migrations\/job-1$/, () => ({ body: { id: "job-1", mode: tenant === DST ? "receiving" : "sending" } }));
  // Only the receiving side returns newId (measured 26/09/2026).
  fake.on(tenant, "GET", /^\/endpoint\/v1\/migrations\/job-1\/endpoints$/, (req) => page(tenant === DST ? jobEndpoints : jobEndpoints.map(({ newId, ...rest }) => rest), req.query));
}
// Ignores the ids filter on purpose, so the stale same-name record is always in the answer.
fake.on(DST, "GET", "/endpoint/v1/endpoints", () => ({ body: { items: destRecords, pages: {} } }));

async function seedJob(extra = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify([{
    localJobId: "local-1", jobName: "move", createdAt: at(0), direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", endpointIds: [OLD], endpointHostnames: { [OLD]: "WIN10" },
    status: "in-progress", sourceSnapshot: null, destSnapshot: null, ...extra,
  }], null, 2));
}
const endpointLookups = () => fake.calls.filter((c) => c.path === "/endpoint/v1/endpoints");

test("the job stays open, waiting for check-in, after the API reports the handover", async () => {
  await seedJob();
  jobEndpoints = [handedOver];
  destRecords = [stale, registered];
  fake.reset();
  const job = await pollJob("local-1");
  assert.equal(job.status, "requested", "handed over is not arrived: the job stays requested until a device checks in");
  assert.deepEqual(job.checkIns[OLD], { state: "waiting", newId: NEW, handedOverAt: at(0.1) });
  assert.equal(awaitingCheckIn(job), true, "the live stream keeps polling");
  const [lookup] = endpointLookups();
  assert.equal(lookup.tenant, "dst", "the receiving tenant is read");
  assert.equal(lookup.query.ids, NEW, "by the new ID");
  assert.equal(lookup.query.hostnameContains, undefined, "never by hostname");
});

test("the check-in is recorded once, with its time and the new ID, and not looked up again", async () => {
  destRecords = [stale, { ...registered, lastSeenAt: at(24.8) }];
  const job = await pollJob("local-1");
  assert.deepEqual(job.checkIns[OLD], { state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8) });
  assert.equal(awaitingCheckIn(job), false);
  assert.deepEqual((await getJob("local-1")).checkIns, job.checkIns, "saved with the job");

  destRecords = [stale, { ...registered, lastSeenAt: at(60) }];
  fake.reset();
  const later = await pollJob("local-1");
  assert.equal(later.checkIns[OLD].checkedInAt, at(24.8));
  assert.equal(endpointLookups().length, 0);
});

test("a move back reads the source tenant, which is then the receiving side", async () => {
  await seedJob({ direction: "dest-to-source" });
  // On a move back DST is the sending side and SRC the receiving one.
  fake.on(SRC, "GET", /^\/endpoint\/v1\/migrations\/job-1$/, () => ({ body: { id: "job-1", mode: "receiving" } }));
  fake.on(DST, "GET", /^\/endpoint\/v1\/migrations\/job-1$/, () => ({ body: { id: "job-1", mode: "sending" } }));
  // Receiving is now SRC: it returns newId, DST (sending) does not.
  fake.on(SRC, "GET", /^\/endpoint\/v1\/migrations\/job-1\/endpoints$/, (req) => page(jobEndpoints, req.query));
  fake.on(DST, "GET", /^\/endpoint\/v1\/migrations\/job-1\/endpoints$/, (req) => page(jobEndpoints.map(({ newId, ...rest }) => rest), req.query));
  fake.on(SRC, "GET", "/endpoint/v1/endpoints", () => ({ body: { items: [registered], pages: {} } }));
  fake.reset();
  const job = await pollJob("local-1");
  assert.equal(job.checkIns[OLD].state, "waiting");
  assert.deepEqual(endpointLookups().map((c) => c.tenant), ["src"]);
});

test("the job page shows a Check-in column and does not call a waiting job complete", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  assert.match(js, /<th>Check-in<\/th>/);
  assert.match(js, /checkInCell\(job\.checkIns\?\.\[m\.id\]\)/);
  assert.match(js, /getElementById\("job-status"\)\.innerHTML = jobStatusTag\(job\)/);
  assert.match(js, /waiting for check-in/);
});
