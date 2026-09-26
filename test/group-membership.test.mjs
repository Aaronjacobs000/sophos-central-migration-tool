// API #4: group membership after a move, using the newId the migration job returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { startMigration } = await import("../backend/dist/services/device-migrator.js");
const { restoreGroupMembership } = await import("../backend/dist/services/group-membership.js");
const { getJob } = await import("../backend/dist/services/migration-store.js");

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const recent = new Date(Date.now() - 3600e3).toISOString();

// Source devices and their groups.
const srcEndpoints = {
  [uuid(1)]: { id: uuid(1), hostname: "LT-1", type: "computer", lastSeenAt: recent, group: { id: "sg-fin", name: "Finance" } },
  [uuid(2)]: { id: uuid(2), hostname: "LT-2", type: "computer", lastSeenAt: recent, group: { id: "sg-fin", name: "Finance" } },
  [uuid(3)]: { id: uuid(3), hostname: "SRV-1", type: "server", lastSeenAt: recent, group: { id: "sg-sql", name: "SQL" } },
  [uuid(4)]: { id: uuid(4), hostname: "LT-4", type: "computer", lastSeenAt: recent },
  [uuid(5)]: { id: uuid(5), hostname: "LT-5", type: "computer", lastSeenAt: recent, group: { id: "sg-dev", name: "Developers" } },
};
fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoints\/[^/]+$/, (req) => {
  const ep = srcEndpoints[req.path.split("/").pop()];
  return ep ? { body: ep } : { status: 404, body: { error: "NotFound", message: "endpoint not found" } };
});

// Migration job endpoints: status and newId per device.
let jobEndpoints = [];
for (const tenant of [SRC, DST]) {
  fake.on(tenant, "GET", /^\/endpoint\/v1\/migrations\/[^/]+\/endpoints$/, (req) => page(tenant === DST ? jobEndpoints : jobEndpoints.map(({ newId, ...rest }) => rest), req.query));
}
fake.on(DST, "POST", "/endpoint/v1/migrations", (req) => ({ status: 201, body: { id: "job-1", token: "handshake", mode: "receiving", endpoints: req.body.endpoints } }));
fake.on(SRC, "PUT", /^\/endpoint\/v1\/migrations\/[^/]+$/, () => ({ body: { id: "job-1", mode: "sending" } }));

// Destination groups and members.
let destGroups = [];
let destMembers = {};
let addBehaviour = () => null;
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page(destGroups, req.query));
fake.on(DST, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, (req) => ({ body: { items: (destMembers[req.path.split("/")[4]] ?? []).map((id) => ({ id })), pages: { size: 500 } } }));
fake.on(DST, "POST", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, (req) => {
  const groupId = req.path.split("/")[4];
  const custom = addBehaviour(groupId, req.body.ids);
  if (custom) return custom;
  destMembers[groupId] = [...(destMembers[groupId] ?? []), ...req.body.ids];
  return { status: 201, body: { addedEndpoints: req.body.ids.map((id) => ({ id })), errors: {} } };
});

async function writeJobs(jobs) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify(jobs, null, 2));
}

function baseJob(extra = {}) {
  return {
    localJobId: "local-1", jobName: "wave 1", createdAt: new Date().toISOString(), direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", fromToken: "x",
    endpointIds: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)],
    endpointHostnames: Object.fromEntries(Object.values(srcEndpoints).map((e) => [e.id, e.hostname])),
    endpointGroups: {
      [uuid(1)]: { id: "sg-fin", name: "Finance" },
      [uuid(2)]: { id: "sg-fin", name: "Finance" },
      [uuid(3)]: { id: "sg-sql", name: "SQL" },
      [uuid(4)]: null,
      [uuid(5)]: { id: "sg-dev", name: "Developers" },
    },
    status: "complete", sourceSnapshot: null, destSnapshot: null,
    ...extra,
  };
}

function seedMoved() {
  jobEndpoints = [
    { id: uuid(1), status: "succeeded", newId: "new-1" },
    { id: uuid(2), status: "succeeded", newId: "new-2" },
    { id: uuid(3), status: "succeeded", newId: "new-3" },
    { id: uuid(4), status: "succeeded", newId: "new-4" },
    { id: uuid(5), status: "pending" },
  ];
  destGroups = [{ id: "dg-fin", name: "FINANCE", type: "computer" }];
  destMembers = { "dg-fin": ["new-2"] };
  addBehaviour = () => null;
}

test("job start records each device's group from the preflight reads; dry run plans without writes", async () => {
  fake.reset();
  const dry = await startMigration({ jobName: "wave 1", endpointIds: [uuid(1), uuid(2), uuid(4)], dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(dry.plan.groups, [{ name: "Finance", count: 2 }]);
  assert.equal(dry.plan.ungrouped, 1);

  const real = await startMigration({ jobName: "wave 1", endpointIds: [uuid(1), uuid(4)] });
  const stored = await getJob(real.job.localJobId);
  assert.deepEqual(stored.endpointGroups, { [uuid(1)]: { id: "sg-fin", name: "Finance" }, [uuid(4)]: null });
  const srcGets = fake.calls.filter((c) => c.tenant === "src" && c.method === "GET" && /\/endpoints\//.test(c.path));
  assert.equal(srcGets.length, 5, "no reads beyond the existing preflight (3 for the dry run, 2 for the real run)");
});

test("dry run: plans additions by name, skips members and reports gaps, writes nothing", async () => {
  seedMoved();
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1", { dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.equal((await readAudit(root)).length, before);
  const by = (n) => res.rows.find((r) => r.endpointId === uuid(n));
  assert.equal(by(1).status, "will-add");
  assert.equal(by(1).destGroupId, "dg-fin", "group names match without case");
  assert.equal(by(2).status, "already-member");
  assert.equal(by(3).status, "group-missing");
  assert.equal(by(4).status, "no-group");
  assert.equal(by(5).status, "not-moved");
  assert.deepEqual(res.groups, [{ name: "Finance", destGroupId: "dg-fin", ids: ["new-1"], ok: null }]);
});

test("real run: posts the new IDs to the destination group and audits it", async () => {
  seedMoved();
  destGroups.push({ id: "dg-sql", name: "SQL", type: "server" });
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1");
  const posts = fake.writes();
  assert.equal(posts.length, 2);
  assert.ok(posts.every((w) => w.tenant === "dst" && w.method === "POST"));
  assert.deepEqual(posts.find((w) => w.path.includes("dg-fin")).body, { ids: ["new-1"] });
  assert.deepEqual(posts.find((w) => w.path.includes("dg-sql")).body, { ids: ["new-3"] });
  assert.equal(res.rows.find((r) => r.endpointId === uuid(1)).status, "added");
  assert.equal(res.rows.find((r) => r.endpointId === uuid(3)).status, "added");
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.ok && e.resource === "endpoint-group-membership" && e.side === "dest"));
});

test("errors: devices the API reports, and a group synced from Active Directory", async () => {
  seedMoved();
  destGroups.push({ id: "dg-sql", name: "SQL", type: "server" });
  addBehaviour = (groupId, ids) => {
    if (groupId === "dg-sql") return { status: 409, body: { error: "Conflict", message: "group is synced from AD" } };
    return { status: 201, body: { addedEndpoints: [], errors: { endpointsNotFound: ids } } };
  };
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1");
  const r1 = res.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1.status, "error");
  assert.match(r1.message, /did not find this device/);
  const r3 = res.rows.find((r) => r.endpointId === uuid(3));
  assert.equal(r3.status, "error");
  assert.match(r3.message, /Active Directory/);
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.ok === false));
});

test("an addition Sophos answers with 500 is sent once, and a read-back that finds the device counts it added", async () => {
  const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([0, 0, 0]);
  seedMoved();
  // Sophos makes the change and still answers 500, as seen live on 26/09/2026.
  addBehaviour = (groupId, ids) => {
    destMembers[groupId] = [...(destMembers[groupId] ?? []), ...ids];
    return { status: 500, body: { error: "InternalError", message: "Error processing data" } };
  };
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1");
  const r1 = res.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1.status, "added");
  assert.match(r1.message, /^Sophos answered 500, but a read-back found the device in the group on the destination/);
  assert.equal(fake.writes().length, 1, "never sent twice");
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ok, true);
  assert.match(entries[0].detail.note, /read-back found/);

  // Not there on any read-back: failed, with the warning to check first.
  seedMoved();
  addBehaviour = () => ({ status: 500, body: { error: "InternalError" } });
  fake.reset();
  const again = await restoreGroupMembership("local-1");
  const r1b = again.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1b.status, "error");
  assert.match(r1b.message, /A read-back did not find it yet\. The change may still have gone through: check the destination before trying again\./);
  assert.equal(fake.writes().length, 1);
});

test("older jobs without a snapshot read the device's group on the sending tenant", async () => {
  seedMoved();
  const job = baseJob();
  delete job.endpointGroups;
  await writeJobs([job]);
  fake.reset();
  const res = await restoreGroupMembership("local-1", { dryRun: true });
  assert.equal(res.rows.find((r) => r.endpointId === uuid(1)).status, "will-add");
  assert.equal(fake.writes().length, 0);
});

test("a job moving devices back to the source adds them on the source tenant", async () => {
  seedMoved();
  await writeJobs([baseJob({ direction: "dest-to-source" })]);
  // In this direction the receiving tenant is the source, which has no groups here.
  fake.reset();
  const res = await restoreGroupMembership("local-1", { dryRun: true });
  assert.equal(res.receivingSide, "source");
  const groupReads = fake.calls.filter((c) => c.path === "/endpoint/v1/endpoint-groups");
  assert.ok(groupReads.every((c) => c.tenant === "src"));
});

test("an unknown job id is a not-found error", async () => {
  await writeJobs([]);
  await assert.rejects(() => restoreGroupMembership("nope"), /not found/);
});
