// The receiver job's handshake token never reaches the logs, the job store or an API response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { startMigration, pollJob } = await import("../backend/dist/services/device-migrator.js");
const { getJob, listJobs, updateJob } = await import("../backend/dist/services/migration-store.js");
const { log, getRingBuffer } = await import("../backend/dist/log.js");
const { logsRouter } = await import("../backend/dist/routes/logs.js");
const { errorHandler } = await import("../backend/dist/middleware/error-handler.js");

const TOKEN = "eyJoYW5kc2hha2UiOiJ0ZXN0In0-handshake-token-value";
const DEVICE = "00000000-0000-4000-8000-000000000001";
const recent = new Date(Date.now() - 60e3).toISOString();
const open = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };

fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "WIN10", type: "computer", lastSeenAt: recent } }));
for (const tenant of [SRC, DST]) {
  fake.on(tenant, "GET", "/endpoint/v1/settings/migration", () => ({ body: open }));
  // Both tenants return the token on every job GET (measured 26/09/2026).
  fake.on(tenant, "GET", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", token: TOKEN, mode: tenant === DST ? "receiving" : "sending" } }));
}
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: "job-1", token: TOKEN, mode: "receiving" } }));
fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", (req) => ({ body: { id: "job-1", mode: "sending", token: req.body.token } }));

const count = (text) => text.split(TOKEN).length - 1;
const jobsFile = () => readFile(path.join(root, "data", "migration-jobs.json"), "utf8");

function logsResponse() {
  const layer = logsRouter.stack.find((l) => l.route?.path === "/logs" && l.route.methods.get);
  let body;
  layer.route.stack[0].handle({ query: {} }, { json: (b) => { body = b; } });
  return JSON.stringify(body);
}

test("a real start logs, stores and returns no handshake token", async () => {
  const res = await startMigration({ jobName: "t", endpointIds: [DEVICE] });
  assert.ok(res.job);
  assert.equal(fake.writes().find((w) => w.method === "PUT").body.token, TOKEN, "the sender trigger still gets the token");
  assert.ok(getRingBuffer().some((e) => e.message.startsWith("Receiver job created")), "the receiver response is logged");
  assert.equal(count(logsResponse()), 0, "/api/logs");
  assert.equal(count(JSON.stringify(res.job)), 0, "start response");
  assert.equal(count(await jobsFile()), 0, "data/migration-jobs.json");
  assert.equal(res.job.fromToken, undefined);
});

test("polling drops the token both tenants return on the job snapshots", async () => {
  const [job] = await listJobs();
  const polled = await pollJob(job.localJobId);
  assert.equal(polled.sourceSnapshot.mode, "sending");
  assert.equal(polled.destSnapshot.mode, "receiving");
  assert.equal(count(JSON.stringify(polled)), 0);
  assert.equal(count(await jobsFile()), 0);
});

test("a job saved with a token by an earlier version is read and rewritten without it", async () => {
  const legacy = {
    localJobId: "legacy-1", jobName: "old", createdAt: recent, direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", fromToken: TOKEN,
    endpointIds: [DEVICE], endpointHostnames: { [DEVICE]: "WIN10" }, status: "complete",
    sourceSnapshot: { id: "job-1", token: TOKEN, mode: "sending" }, destSnapshot: { id: "job-1", token: TOKEN, mode: "receiving" },
  };
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify([legacy], null, 2));
  assert.equal(count(JSON.stringify(await getJob("legacy-1"))), 0, "read");
  assert.equal(count(JSON.stringify(await listJobs())), 0, "list");
  await updateJob("legacy-1", { lastPolledAt: new Date().toISOString() });
  assert.equal(count(await jobsFile()), 0, "file after the next write");
});

// The start in the first test registered TOKEN as a secret value.
test("the token is masked by value in messages and error responses, and by field name in detail", () => {
  log.emit("info", "migration", `sender said ${TOKEN}`, { detail: { nested: { token: "other-secret-value", clientSecret: "abc12345" } } });
  log.error(`PUT failed: ${TOKEN}`);
  const out = logsResponse();
  assert.equal(count(out), 0);
  assert.doesNotMatch(out, /other-secret-value|abc12345/);

  let body;
  const res = { headersSent: false, status() { return this; }, json(b) { body = b; } };
  errorHandler(new Error(`Sophos API error 400: bad token ${TOKEN}`), { method: "POST", path: "/migrate/devices" }, res, () => {});
  assert.match(body.message, /Sophos API error 400/);
  assert.equal(count(body.message), 0);
});
