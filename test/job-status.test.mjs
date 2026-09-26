// Job status from the devices: requested, in progress, completed, and how failures and long waits end a job.
import { test } from "node:test";
import assert from "node:assert/strict";

const { jobProgress, nextCheckDelayMs, JOB_LIFETIME_MS } = await import("../backend/dist/services/job-progress.js");
const { publicJob } = await import("../backend/dist/services/job-view.js");

const T0 = Date.UTC(2026, 8, 25, 22, 34);
const at = (min) => new Date(T0 + min * 60e3).toISOString();
const MIN = 60e3;
const DAY = 24 * 60 * MIN;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const newId = (n) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;

const pending = (n) => ({ entry: { id: id(n), status: "pending" } });
const handedOver = (n) => ({
  entry: { id: id(n), status: "succeeded", newId: newId(n), migratedAt: at(0.1) },
  checkIn: { state: "waiting", newId: newId(n), handedOverAt: at(0.1) },
});
const arrived = (n, min = 24) => ({
  entry: { id: id(n), status: "succeeded", newId: newId(n), migratedAt: at(0.1) },
  checkIn: { state: "checked-in", newId: newId(n), handedOverAt: at(0.1), checkedInAt: at(min) },
});
const failed = (n) => ({ entry: { id: id(n), status: "failed", reason: "not eligible" }, checkIn: { state: "move-failed" } });

/** A job as the store saves it, from the receiving side's answer and the saved check-ins. */
function job(devices, extra = {}) {
  const ids = devices.map((_, i) => id(i + 1));
  const entries = devices.map((d, i) => ({ ...d(i + 1).entry }));
  const checkIns = Object.fromEntries(devices.map((d, i) => [id(i + 1), d(i + 1).checkIn]).filter(([, c]) => c));
  const expiresAt = new Date(T0 + JOB_LIFETIME_MS).toISOString();
  return {
    localJobId: "local-1", jobName: "Finance laptops", createdAt: at(0), direction: "source-to-dest",
    sourceMigrationId: "m-1", destMigrationId: "m-1", endpointIds: ids,
    endpointHostnames: Object.fromEntries(ids.map((x, i) => [x, `LT-${i + 1}`])),
    status: "requested",
    sourceSnapshot: { id: "m-1", mode: "sending", expiresAt, endpointDetails: entries.map(({ newId: _n, ...e }) => e) },
    destSnapshot: { id: "m-1", mode: "receiving", expiresAt, endpointDetails: entries },
    checkIns,
    ...extra,
  };
}

test("requested once Sophos has accepted the job, checked every 10 seconds while it hands devices over", () => {
  const j = job([pending, pending, pending]);
  const p = jobProgress(j, T0 + MIN);
  assert.equal(p.status, "requested");
  assert.deepEqual([p.requested, p.waiting, p.arrived, p.percent, p.finished], [3, 0, 0, 0, false]);
  assert.equal(nextCheckDelayMs(j, p), 10_000);
});

test("handed over is not arrived: still requested, checked every 30 seconds until devices check in", () => {
  const j = job([handedOver, handedOver, handedOver]);
  const p = jobProgress(j, T0 + 5 * MIN);
  assert.equal(p.status, "requested");
  assert.deepEqual([p.waiting, p.arrived, p.percent], [3, 0, 0]);
  assert.equal(p.devices[0].newId, newId(1));
  assert.equal(nextCheckDelayMs(j, p), 30_000);
});

test("in progress once one device has checked in; the percentage never rounds up to done", () => {
  const one = jobProgress(job([arrived, handedOver, handedOver]), T0 + 25 * MIN);
  assert.equal(one.status, "in-progress");
  assert.deepEqual([one.arrived, one.waiting, one.percent], [1, 2, 33]);
  const two = jobProgress(job([arrived, arrived, handedOver]), T0 + 25 * MIN);
  assert.equal(two.percent, 66, "2 of 3 is 66, not 67");
  assert.equal(two.finished, false);
});

test("completed once every device has checked in, and the stream stops", () => {
  const j = job([arrived, arrived, arrived]);
  const p = jobProgress(j, T0 + 30 * MIN);
  assert.equal(p.status, "completed");
  assert.deepEqual([p.arrived, p.percent, p.finished], [3, 100, true]);
  assert.equal(p.devices[2].checkedInAt, at(24));
  assert.equal(nextCheckDelayMs(j, p), null);
});

test("a device Sophos fails: completed with failures when others arrived, failed when none did, open while others wait", () => {
  const mixed = jobProgress(job([arrived, failed, arrived]), T0 + 30 * MIN);
  assert.equal(mixed.status, "completed-with-failures");
  assert.deepEqual([mixed.arrived, mixed.failed, mixed.percent, mixed.finished], [2, 1, 66, true]);
  assert.equal(mixed.devices[1].state, "failed");
  assert.equal(mixed.devices[1].reason, "not eligible");

  const none = jobProgress(job([failed, failed]), T0 + 30 * MIN);
  assert.equal(none.status, "failed");

  const open = jobProgress(job([failed, handedOver]), T0 + 30 * MIN);
  assert.equal(open.status, "requested", "one device is still waiting, so the job has not ended");
  assert.equal(open.finished, false);
  assert.equal(open.failed, 1);
});

test("a long wait is a wait, not a failure: an offline laptop shows how long it has waited", () => {
  const j = job([arrived, handedOver]);
  const p = jobProgress(j, T0 + 3 * DAY);
  assert.equal(p.status, "in-progress");
  assert.equal(p.devices[1].state, "waiting");
  assert.equal(p.oldestWaitSince, at(0.1));
  assert.equal(p.failed + p.expired, 0);
  assert.equal(nextCheckDelayMs(j, p), 30_000);
});

test("after the job expires (14 days), a device that never checked in counts as not moved and the job ends", () => {
  const j = job([arrived, handedOver, pending]);
  const p = jobProgress(j, T0 + 15 * DAY);
  assert.deepEqual(p.devices.map((d) => d.state), ["arrived", "expired", "expired"]);
  assert.equal(p.status, "completed-with-failures");
  assert.equal(p.finished, true);
  assert.equal(p.expiresAt, new Date(T0 + JOB_LIFETIME_MS).toISOString());
  assert.equal(jobProgress(job([handedOver]), T0 + 15 * DAY).status, "failed");
});

test("a job saved at the handover as complete by an earlier version is reported as requested", () => {
  // No check-ins saved: the snapshot shows the handover only.
  const legacy = job([handedOver], { status: "complete", checkIns: undefined });
  const view = publicJob(legacy, T0 + 10 * MIN);
  assert.equal(view.status, "requested");
  assert.equal(view.progress.waiting, 1);
  assert.equal(view.progress.devices[0].newId, newId(1));
});

test("the stream slows to every 5 minutes while a job can't be checked, and every minute after an error", () => {
  const j = job([handedOver]);
  for (const state of ["rejected", "no-credentials", "not-found"]) {
    assert.equal(nextCheckDelayMs({ ...j, monitor: { state } }, jobProgress(j, T0)), 5 * 60_000, state);
  }
  assert.equal(nextCheckDelayMs({ ...j, monitor: { state: "error" } }, jobProgress(j, T0)), 60_000);
});
