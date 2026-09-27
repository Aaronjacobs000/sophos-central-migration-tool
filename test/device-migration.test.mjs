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

test("the start route reports migration turned off as migration_not_allowed, which the page keys its fix on", async () => {
  const { startHttp } = await import("./helpers/http.mjs");
  const http = await startHttp([migrateDevicesRouter]);
  try {
    setting.src = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
    setting.dst = { enabled: false };
    fake.reset();
    const res = await http.post("/api/migrate/devices", { jobName: "t", endpointIds: [DEVICE] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "migration_not_allowed");
    assert.match(res.body.message, /Test Destination \(the receiving tenant\): Device migration is turned off/);
    assert.equal(migrationWrites().length, 0);
  } finally {
    setting.dst = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
    await http.close();
  }
});

test("the start page shows the Device Migration fix only for migration_not_allowed, and any other error as it is", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function migrationErrorHint"), js.indexOf("boot();"));
  const hint = new Function(`${src}; return migrationErrorHint;`)();
  const FIX = /turn on <strong>Allow device migration<\/strong>/;

  const off = "Device migration is not allowed. Test Destination (the receiving tenant): Device migration is turned off. Both tenants must allow it.";
  const shown = hint({ message: off, body: { error: "migration_not_allowed", message: off } }, "Migration start failed");
  assert.match(shown, FIX);
  assert.match(shown, /on each tenant named above/);
  assert.doesNotMatch(shown, /on the <strong>sending<\/strong> tenant/, "the tenant that has it off may be the receiving one");

  // A 403 during the trigger read-back mentions both "403" and "migration": shown as it is, escaped, with no fix.
  const readBack = "Sophos API error 500: InternalError. A read-back could not read migration job job-9 on the sending tenant Test Source (Sophos API error 403: Forbidden - no read). The change may still have gone through: check the Migrations page before trying again. The Migrations page lists the jobs on both tenants, including ones this tool did not save.";
  assert.equal(hint({ message: readBack, body: { error: "internal_error", message: readBack } }, "x"), readBack);
  const refused = "Sophos API error 403: Forbidden - not allowed to create a migration <job>";
  assert.equal(hint({ message: refused, body: { error: "internal_error" } }, "x"), "Sophos API error 403: Forbidden - not allowed to create a migration &lt;job&gt;");
  assert.equal(hint({ message: "Device migration is not enabled for this tenant" }, "x"), "Device migration is not enabled for this tenant", "only the server's code, not the wording, brings the fix");

  // The tenant mismatch hint stays, and an error with no message falls back.
  assert.match(hint({ message: "fromTenant must not match the current tenant" }, "x"), /appear to be the same tenant/);
  assert.equal(hint({}, "Dry run failed"), "Dry run failed");
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
