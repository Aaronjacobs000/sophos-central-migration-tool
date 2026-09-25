// Device moves: both tenants must allow migration, and cancel reports what Sophos did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { startMigration, cancelJob } = await import("../backend/dist/services/device-migrator.js");
const { getJob } = await import("../backend/dist/services/migration-store.js");

const DEVICE = "00000000-0000-4000-8000-000000000001";
const recent = new Date(Date.now() - 60e3).toISOString();
fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "WIN10", type: "computer", lastSeenAt: recent } }));

const setting = { src: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" }, dst: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } };
fake.on(SRC, "GET", "/endpoint/v1/settings/migration", () => ({ body: setting.src }));
fake.on(DST, "GET", "/endpoint/v1/settings/migration", () => ({ body: setting.dst }));
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: "job-1", token: "handshake", mode: "receiving" } }));
fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));

const migrationWrites = () => fake.writes().filter((w) => w.path.startsWith("/endpoint/v1/migrations"));

test("a start is refused, with no job created, when the receiving tenant has migration off", async () => {
  setting.src.enabled = true;
  setting.dst.enabled = false;
  for (const dryRun of [true, false]) {
    fake.reset();
    const res = await startMigration({ jobName: "t", endpointIds: [DEVICE], dryRun });
    assert.match(res.settingFailure ?? "", /Test Destination \(the receiving tenant\): Device migration is turned off/);
    assert.equal(res.plan, undefined);
    assert.equal(res.job, undefined);
    assert.equal(migrationWrites().length, 0);
  }
});

test("a start is refused when the sending tenant's window has closed", async () => {
  setting.src = { enabled: true, expiresAt: "2020-01-01T00:00:00Z" };
  setting.dst = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
  fake.reset();
  const res = await startMigration({ jobName: "t", endpointIds: [DEVICE] });
  assert.match(res.settingFailure ?? "", /Test Source \(the sending tenant\): The migration window closed/);
  assert.equal(migrationWrites().length, 0);
});

test("with both tenants open the receiver job and the sender trigger are sent", async () => {
  setting.src = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
  fake.reset();
  const res = await startMigration({ jobName: "t", endpointIds: [DEVICE] });
  assert.equal(res.settingFailure, undefined);
  assert.ok(res.job);
  assert.deepEqual(migrationWrites().map((w) => `${w.tenant} ${w.method}`), ["dst POST", "src PUT"]);
});

test("cancel does not mark the job cancelled when both deletes are refused, and audits the refusal", async () => {
  fake.reset();
  const { job } = await startMigration({ jobName: "cancel me", endpointIds: [DEVICE] });
  // As the live API answered on 25/09/2026: no delete route.
  for (const t of [SRC, DST]) fake.on(t, "DELETE", "/endpoint/v1/migrations/job-1", () => ({ status: 404, body: { error: "NotFound" } }));
  const before = (await readAudit(root)).length;
  await assert.rejects(cancelJob(job.localJobId), /Sophos did not cancel the job/);
  assert.equal((await getJob(job.localJobId)).status, "in-progress");
  const entries = (await readAudit(root)).slice(before);
  assert.deepEqual(entries.map((e) => [e.resource, e.ok]), [["migration-sender", false], ["migration-receiver", false]]);
  assert.ok(entries.every((e) => /404/.test(e.error)));
});

test("cancel marks the job cancelled when a tenant confirms the delete", async () => {
  fake.reset();
  const { job } = await startMigration({ jobName: "cancel me too", endpointIds: [DEVICE] });
  fake.on(DST, "DELETE", "/endpoint/v1/migrations/job-1", () => ({ status: 204 }));
  await cancelJob(job.localJobId);
  assert.equal((await getJob(job.localJobId)).status, "cancelled");
});
