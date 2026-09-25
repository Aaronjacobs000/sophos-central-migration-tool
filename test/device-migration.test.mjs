// Device moves: both tenants must allow migration, and there is no cancel, because Sophos has none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { readFile } from "node:fs/promises";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const migrator = await import("../backend/dist/services/device-migrator.js");
const { startMigration } = migrator;
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");

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

test("no route or service can cancel or delete a job", () => {
  // The migrations API has no cancel or delete (DELETE answered 404 on 25/09/2026).
  const routes = migrateDevicesRouter.stack.filter((l) => l.route).map((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).flat();
  assert.ok(routes.includes("post /migrate/devices"), "the router is the real one");
  assert.deepEqual(routes.filter((r) => r.startsWith("delete")), []);
  assert.equal(migrator.cancelJob, undefined);
});

test("the job page has no Cancel button and says a move can't be cancelled", async () => {
  const html = await readFile(new URL("../frontend/migrate-job-detail.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /cancel-btn|Cancel migration/);
  assert.match(html, /can't be cancelled/);
  assert.doesNotMatch(js, /api\.del\(|cancel-btn/);
});
