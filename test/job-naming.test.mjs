// A job has the name the user gave it, on the Migrations list and the job monitor, so jobs can be told apart.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
const http = await startHttp([migrateDevicesRouter]);
after(() => http.close());

const DEVICE = "00000000-0000-4000-8000-000000000001";
const recent = new Date(Date.now() - 60e3).toISOString();
fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "WIN10", type: "computer", lastSeenAt: recent } }));
for (const t of [SRC, DST]) fake.on(t, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } }));
let seq = 0;
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: `job-${++seq}`, token: "handshake-token-value", mode: "receiving" } }));
fake.on(SRC, "PUT", /^\/endpoint\/v1\/migrations\/job-\d+$/, (req) => ({ body: { id: req.path.split("/").pop(), mode: "sending" } }));

test("a job needs a name, and nothing is sent to Sophos without one", async () => {
  fake.reset();
  const res = await http.post("/api/migrate/devices", { jobName: "   ", endpointIds: [DEVICE] });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /jobName/);
  assert.equal(fake.writes().length, 0);
});

test("two jobs keep their own names on the list, the merged list and the job detail", async () => {
  const a = (await http.post("/api/migrate/devices", { jobName: "Finance laptops, wave 1", endpointIds: [DEVICE] })).body.job;
  const b = (await http.post("/api/migrate/devices", { jobName: "Finance laptops, wave 2", endpointIds: [DEVICE] })).body.job;
  assert.equal(a.jobName, "Finance laptops, wave 1");
  assert.equal(b.jobName, "Finance laptops, wave 2");
  const list = (await http.get("/api/migrate/devices/jobs")).body.items;
  const all = (await http.get("/api/migrate/devices/jobs/all")).body.items;
  for (const items of [list, all]) {
    assert.equal(items.find((j) => j.localJobId === a.localJobId).jobName, "Finance laptops, wave 1");
    assert.equal(items.find((j) => j.localJobId === b.localJobId).jobName, "Finance laptops, wave 2");
  }
  assert.equal((await http.get(`/api/migrate/devices/jobs/${b.localJobId}`)).body.jobName, "Finance laptops, wave 2");
});
