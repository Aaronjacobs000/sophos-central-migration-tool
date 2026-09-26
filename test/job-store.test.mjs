// The job store in data/migration-jobs.json: one failed save fails alone. Before 26/09/2026 one failed save
// failed every later one until the tool restarted.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const store = await import("../backend/dist/services/migration-store.js");
store.setRetryDelay(1);

const jobsFile = path.join(root, "data", "migration-jobs.json");
const original = { rename: fsp.rename, open: fsp.open, writeFile: fsp.writeFile };
after(() => Object.assign(fsp, original));

// Enough devices per job that a save takes a moment to write.
const DEVICES = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const newJob = (n) => store.createJob({
  jobName: `Wave ${n}`,
  direction: "source-to-dest",
  sourceMigrationId: `m-${n}`,
  destMigrationId: `m-${n}`,
  endpointIds: DEVICES,
  endpointHostnames: Object.fromEntries(DEVICES.map((id, i) => [id, `LT-${n}-${i}`])),
});

const jobs = [];
for (let n = 1; n <= 20; n++) jobs.push(await newJob(n));

const lockError = (target) => Object.assign(new Error(`EBUSY: resource busy or locked, '${target}'`), { code: "EBUSY" });

test("a failed save fails that call only, and the next save goes through", async () => {
  const [job] = jobs;
  // A lock on the jobs file that outlasts every retry.
  fsp.rename = async (from, to) => { if (path.resolve(String(to)) === jobsFile) throw lockError(to); return original.rename(from, to); };
  fsp.open = async (file, ...rest) => { if (path.resolve(String(file)) === jobsFile) throw lockError(file); return original.open(file, ...rest); };
  fsp.writeFile = async (file, ...rest) => { if (path.resolve(String(file)) === jobsFile) throw lockError(file); return original.writeFile(file, ...rest); };
  await assert.rejects(store.updateJob(job.localJobId, { jobName: "while locked" }), (err) => {
    assert.match(err.message, /couldn't save the migration jobs/i);
    assert.match(err.message, /locked/);
    return true;
  });
  Object.assign(fsp, original);

  assert.equal((await store.getJob(job.localJobId)).jobName, "Wave 1", "the failed save changed nothing");
  const saved = await store.updateJob(job.localJobId, { jobName: "after the lock" });
  assert.equal(saved.jobName, "after the lock");
  assert.equal((await store.getJob(job.localJobId)).jobName, "after the lock");
  assert.equal(JSON.parse(await readFile(jobsFile, "utf8")).find((j) => j.localJobId === job.localJobId).jobName, "after the lock");
});
