// The Migrations page lists jobs started elsewhere from both tenants' APIs. Sophos gives both tenants the
// same job ID, so a job on both is one row, and that row is the sending side's: it shows the move started.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
const http = await startHttp([migrateDevicesRouter]);
after(() => http.close());

const at = "2026-09-27T02:13:51Z";
let srcJobs = [];
let dstJobs = [];
fake.on(SRC, "GET", "/endpoint/v1/migrations", (req) => page(srcJobs, req.query));
fake.on(DST, "GET", "/endpoint/v1/migrations", (req) => page(dstJobs, req.query));
const apiRows = async () => (await http.get("/api/migrate/devices/jobs/all")).body.items.filter((j) => j.origin === "api");

test("a move back started elsewhere shows as sending on the destination, not as receiving on the source", async () => {
  srcJobs = [{ id: "back-1", mode: "receiving", createdAt: at }];
  dstJobs = [{ id: "back-1", mode: "sending", createdAt: at }];
  const rows = await apiRows();
  assert.equal(rows.length, 1, "one row per job ID");
  assert.equal(rows[0].apiMigrationId, "back-1");
  assert.equal(rows[0].apiJobMode, "sending");
  assert.equal(rows[0].apiTenant, "dest");
});

test("a job only one tenant knows is listed from that tenant, and a forward move keeps its sending source row", async () => {
  srcJobs = [{ id: "fwd-1", mode: "sending", createdAt: at }];
  dstJobs = [{ id: "fwd-1", mode: "receiving", createdAt: at }, { id: "waiting-1", mode: "receiving", createdAt: at }];
  const rows = await apiRows();
  const by = (id) => rows.filter((r) => r.apiMigrationId === id);
  assert.equal(by("fwd-1").length, 1);
  assert.equal(by("fwd-1")[0].apiTenant, "source");
  assert.equal(by("fwd-1")[0].apiJobMode, "sending");
  assert.equal(by("waiting-1").length, 1);
  assert.equal(by("waiting-1")[0].apiJobMode, "receiving", "a receiving job the sending tenant never picked up");
});
