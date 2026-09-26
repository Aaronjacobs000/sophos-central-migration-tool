// The job store in data/migration-jobs.json: reads queue behind saves, a save replaces the file whole, a file
// cut off half way is recovered from data/migration-jobs.backup.json, and one failed save fails alone. Before
// 26/09/2026 a read during a save could get half a file, and one failed save failed every later one until the
// tool restarted.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const store = await import("../backend/dist/services/migration-store.js");
const { getRingBuffer } = await import("../backend/dist/log.js");
store.setRetryDelay(1);

const jobsFile = path.join(root, "data", "migration-jobs.json");
const backupFile = path.join(root, "data", "migration-jobs.backup.json");
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
const ids = new Set(jobs.map((j) => j.localJobId));

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

test("reads during saves always get every job, and the file on disk is always whole", async () => {
  let saving = true;
  const saves = (async () => {
    try {
      for (let round = 0; round < 100; round++) {
        await Promise.all([
          store.updateJob(jobs[round % jobs.length].localJobId, { lastPolledAt: new Date().toISOString() }),
          store.updateJob(jobs[(round + 7) % jobs.length].localJobId, { lastError: `round ${round}` }),
        ]);
      }
    } finally {
      saving = false;
    }
  })();
  const read = [
    async () => store.listJobs(),
    async () => [await store.getJob(jobs[3].localJobId)],
    async () => JSON.parse(await readFile(jobsFile, "utf8")),
  ];
  const readers = [...read, ...read].map(async (fn) => {
    let count = 0;
    while (saving) {
      const got = await fn();
      assert.ok(got.length === 1 ? got[0]?.localJobId === jobs[3].localJobId : got.length === jobs.length, `read ${count}`);
      assert.ok(got.every((j) => ids.has(j.localJobId)), `read ${count}`);
      count++;
    }
    return count;
  });
  const counts = await Promise.all([saves, ...readers]);
  assert.ok(counts.slice(1).every((n) => n > 0), `reads per reader: ${counts.slice(1).join(", ")}`);
});

test("a jobs file cut off half way is recovered from the backup, and the next save rewrites it", async () => {
  const whole = await readFile(jobsFile, "utf8");
  assert.equal(await readFile(backupFile, "utf8"), whole, "the backup holds the last save");
  await writeFile(jobsFile, whole.slice(0, Math.floor(whole.length / 2)));

  const listed = await store.listJobs();
  assert.deepEqual(listed.map((j) => j.localJobId), JSON.parse(whole).map((j) => j.localJobId));
  assert.ok(getRingBuffer().some((e) => e.level === "warn" && /migration-jobs\.backup\.json/.test(e.message)), "the recovery is logged");

  const [job] = listed;
  await store.updateJob(job.localJobId, { jobName: "after the recovery" });
  const rewritten = JSON.parse(await readFile(jobsFile, "utf8"));
  assert.equal(rewritten.length, jobs.length);
  assert.equal(rewritten.find((j) => j.localJobId === job.localJobId).jobName, "after the recovery");
});

test("a jobs file that can't be read, with no backup, is an error and is left as it is", async () => {
  const whole = await readFile(jobsFile, "utf8");
  const [job] = JSON.parse(whole);
  await rm(backupFile);
  await writeFile(jobsFile, "");
  try {
    await assert.rejects(store.listJobs(), /can't be read/);
    await assert.rejects(store.updateJob(job.localJobId, { jobName: "lost" }), /can't be read/);
    assert.equal(await readFile(jobsFile, "utf8"), "", "nothing was written over it");
  } finally {
    await writeFile(jobsFile, whole);
  }
  assert.equal((await store.listJobs()).length, jobs.length);
});

test("with the rename onto the jobs file locked, a save writes it in place once the backup holds the same list", async () => {
  const [job] = jobs;
  fsp.rename = async (from, to) => { if (path.resolve(String(to)) === jobsFile) throw lockError(to); return original.rename(from, to); };
  try {
    const saved = await store.updateJob(job.localJobId, { jobName: "rename locked" });
    assert.equal(saved.jobName, "rename locked");
  } finally {
    Object.assign(fsp, original);
  }
  const disk = await readFile(jobsFile, "utf8");
  assert.equal(JSON.parse(disk).find((j) => j.localJobId === job.localJobId).jobName, "rename locked");
  assert.equal(await readFile(backupFile, "utf8"), disk);
  assert.ok(getRingBuffer().some((e) => /written in place/.test(e.message)), "the in-place write is logged");
});

test("the jobs file is not written in place while the backup can't be saved", async () => {
  const [job] = jobs;
  const before = await readFile(jobsFile, "utf8");
  const locked = new Set([jobsFile, backupFile]);
  fsp.rename = async (from, to) => { if (locked.has(path.resolve(String(to)))) throw lockError(to); return original.rename(from, to); };
  fsp.open = async (file, ...rest) => { if (path.resolve(String(file)) === backupFile) throw lockError(file); return original.open(file, ...rest); };
  try {
    await assert.rejects(store.updateJob(job.localJobId, { jobName: "both locked" }), /couldn't save the migration jobs/i);
  } finally {
    Object.assign(fsp, original);
  }
  assert.equal(await readFile(jobsFile, "utf8"), before);
  assert.equal((await store.updateJob(job.localJobId, { jobName: "unlocked" })).jobName, "unlocked");
});
