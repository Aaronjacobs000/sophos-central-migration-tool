// Device moves: both tenants must allow migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { startMigration } = await import("../backend/dist/services/device-migrator.js");

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
