// data/job-credentials.json is saved like the job store: whole, with a copy in data/job-credentials.auto-backup.json
// that a file cut off by a crash is recovered from, with retries while OneDrive or antivirus holds it, and mode 0600
// for every copy. Before 26/09/2026 it was written in place with no retries, so a crash mid-save left every job
// unable to read its stored credentials.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { readFile, writeFile, readdir, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const creds = await import("../backend/dist/services/job-credentials.js");
const { setRetryDelay } = await import("../backend/dist/services/safe-files.js");
const { getRingBuffer } = await import("../backend/dist/log.js");
setRetryDelay(1);

const dataDir = path.join(root, "data");
const vaultFile = path.join(dataDir, "job-credentials.json");
const backupFile = path.join(dataDir, "job-credentials.auto-backup.json");
const original = { rename: fsp.rename, open: fsp.open, writeFile: fsp.writeFile };
after(() => Object.assign(fsp, original));

const windows = process.platform === "win32";
const lockError = (target) => Object.assign(new Error(`EBUSY: resource busy or locked, '${target}'`), { code: "EBUSY" });
const cred = (i) => ({ clientId: `save-client-${i}`, clientSecret: `save-secret-value-${i}` });
const is = (file, target) => path.resolve(String(file)) === target;
const tempFiles = async () => (await readdir(dataDir)).filter((f) => f.endsWith(".tmp"));
const entryIds = async () => JSON.parse(await readFile(vaultFile, "utf8")).entries.map((e) => e.id);

// Nothing written to the log or an error may carry the file's contents.
function assertNoContents(text, ids) {
  for (const id of ids) assert.ok(!text.includes(id), "no entry ID");
  assert.ok(!/save-secret-value|save-client|"data"|"iv"|"tag"/.test(text), "no credential or vault field");
}

const ids = [];
for (let i = 0; i < 5; i++) ids.push(await creds.putCredential("tenant", cred(i)));

test("a save leaves the file and its backup whole, the same, and in data/ with no temp file", async () => {
  const vault = await readFile(vaultFile, "utf8");
  assert.equal(JSON.parse(vault).entries.length, ids.length);
  assert.equal(await readFile(backupFile, "utf8"), vault);
  assert.deepEqual(await tempFiles(), []);
});

test("the file and its backup are mode 0600 after a save", { skip: windows && "file modes are not enforced on Windows" }, async () => {
  await chmod(vaultFile, 0o644);
  await chmod(backupFile, 0o644);
  await creds.putCredential("tenant", cred(0));
  assert.equal((await stat(vaultFile)).mode & 0o777, 0o600);
  assert.equal((await stat(backupFile)).mode & 0o777, 0o600);
});

test("a temp file is created with mode 0600, beside the file", { skip: windows && "file modes are not enforced on Windows" }, async () => {
  const temps = [];
  fsp.open = async (file, flags, mode) => {
    if (String(file).endsWith(".tmp")) temps.push({ dir: path.dirname(path.resolve(String(file))), mode });
    return original.open(file, flags, mode);
  };
  try {
    await creds.putCredential("tenant", cred(1));
  } finally {
    Object.assign(fsp, original);
  }
  assert.equal(temps.length, 2, "one for the backup, one for the file");
  for (const t of temps) {
    assert.equal(t.dir, dataDir);
    assert.equal(t.mode, 0o600);
  }
});

test("a lock that clears within the retries: the save goes through", async () => {
  let renames = 0;
  fsp.rename = async (from, to) => {
    if (is(to, vaultFile) && renames++ < 2) throw lockError(to);
    return original.rename(from, to);
  };
  let id;
  try {
    id = await creds.putCredential("tenant", cred(20));
  } finally {
    Object.assign(fsp, original);
  }
  assert.equal(renames, 3, "renamed on the third try");
  assert.equal((await creds.getCredential(id)).clientId, cred(20).clientId);
  assert.ok((await entryIds()).includes(id));
  assert.equal(await readFile(backupFile, "utf8"), await readFile(vaultFile, "utf8"));
  assert.ok(getRingBuffer().some((e) => e.section === "job-credentials" && /replace job-credentials\.json: EBUSY, retry 1\/5/.test(e.message)));
  if (!windows) assert.equal((await stat(vaultFile)).mode & 0o777, 0o600);
});

test("with the rename locked, the file is written in place once the backup holds the save, and stays 0600", async () => {
  if (!windows) await chmod(vaultFile, 0o644);
  fsp.rename = async (from, to) => { if (is(to, vaultFile)) throw lockError(to); return original.rename(from, to); };
  let id;
  try {
    id = await creds.putCredential("tenant", cred(21));
  } finally {
    Object.assign(fsp, original);
  }
  assert.equal((await creds.getCredential(id)).clientId, cred(21).clientId);
  assert.equal(await readFile(backupFile, "utf8"), await readFile(vaultFile, "utf8"));
  assert.ok(getRingBuffer().some((e) => /job-credentials\.json stayed locked \(EBUSY\), so it was written in place/.test(e.message)));
  if (!windows) assert.equal((await stat(vaultFile)).mode & 0o777, 0o600);
  assert.deepEqual(await tempFiles(), []);
});

test("a lock that outlasts the retries fails the save clearly, leaves the file whole, and the next save goes through", async () => {
  const before = await readFile(vaultFile, "utf8");
  const idsBefore = await entryIds();
  const logStart = getRingBuffer().length;
  fsp.rename = async (from, to) => { if (is(to, vaultFile)) throw lockError(to); return original.rename(from, to); };
  fsp.open = async (file, ...rest) => { if (is(file, vaultFile)) throw lockError(file); return original.open(file, ...rest); };
  fsp.writeFile = async (file, ...rest) => { if (is(file, vaultFile)) throw lockError(file); return original.writeFile(file, ...rest); };
  try {
    await assert.rejects(creds.putCredential("tenant", cred(22)), (err) => {
      assert.match(err.message, /couldn't save the job credentials/i);
      assert.match(err.message, /data\/job-credentials\.json stayed locked \(EBUSY\)/);
      assertNoContents(err.message, idsBefore);
      return true;
    });
  } finally {
    Object.assign(fsp, original);
  }
  assert.equal(await readFile(vaultFile, "utf8"), before, "the file is as it was");
  assert.deepEqual(await tempFiles(), []);
  assertNoContents(getRingBuffer().slice(logStart).map((e) => e.message).join("\n"), idsBefore);
  for (const [i, id] of ids.entries()) assert.equal((await creds.getCredential(id)).clientId, cred(i).clientId);

  const id = await creds.putCredential("tenant", cred(23));
  assert.equal((await creds.getCredential(id)).clientId, cred(23).clientId);
});

test("a file cut off by a crash mid-save is recovered from the backup, and the next save rewrites it", async () => {
  const whole = await readFile(vaultFile, "utf8");
  const idsBefore = await entryIds();
  assert.equal(await readFile(backupFile, "utf8"), whole, "the backup holds the last save");
  const logStart = getRingBuffer().length;
  await writeFile(vaultFile, whole.slice(0, Math.floor(whole.length / 2)));

  for (const [i, id] of ids.entries()) assert.equal((await creds.getCredential(id)).clientId, cred(i).clientId);
  const recovery = getRingBuffer().slice(logStart).map((e) => e.message).join("\n");
  assert.match(recovery, /job-credentials\.json is damaged, so the \d+ stored credentials in data\/job-credentials\.auto-backup\.json were used/);
  assertNoContents(recovery, idsBefore);

  const id = await creds.putCredential("tenant", cred(24));
  const rewritten = JSON.parse(await readFile(vaultFile, "utf8"));
  assert.equal(rewritten.entries.length, idsBefore.length + 1);
  assert.ok(rewritten.entries.some((e) => e.id === id));
});

test("a file that can't be read, with no usable backup, is an error that quotes neither, and is left as it is", async () => {
  const whole = await readFile(vaultFile, "utf8");
  const backup = await readFile(backupFile, "utf8");
  const idsBefore = await entryIds();
  const cut = whole.slice(0, Math.floor(whole.length / 2));
  await writeFile(vaultFile, cut);
  await writeFile(backupFile, cut);
  try {
    for (const call of [() => creds.getCredential(ids[0]), () => creds.putCredential("tenant", cred(25))]) {
      await assert.rejects(call(), (err) => {
        assert.match(err.message, /can't be read: data\/job-credentials\.json is damaged, and the backup is damaged/);
        assertNoContents(err.message, idsBefore);
        return true;
      });
    }
    assert.equal(await readFile(vaultFile, "utf8"), cut, "nothing was written over it");
  } finally {
    await writeFile(vaultFile, whole);
    await writeFile(backupFile, backup);
  }
  assert.equal((await creds.getCredential(ids[0])).clientId, cred(0).clientId);
});
