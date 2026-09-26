// The wizard's save of .env retries while OneDrive or antivirus holds the file, keeps the file whole and mode 0600,
// and a lock that outlasts the retries fails the save clearly and leaves .env as it was, with no temp file (which
// holds the secrets) left behind. Before 26/09/2026 a lock on .env failed the save at once and left the temp file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root, state } = await bootApp(fake);
const { credentialsRouter } = await import("../backend/dist/routes/credentials.js");
const { setRetryDelay } = await import("../backend/dist/services/safe-files.js");
const { getRingBuffer } = await import("../backend/dist/log.js");
setRetryDelay(1);
const http = await startHttp([credentialsRouter]);

const envFile = path.join(root, ".env");
const original = { rename: fsp.rename, readFile: fsp.readFile };
after(() => { Object.assign(fsp, original); return http.close(); });

const windows = process.platform === "win32";
const lockError = (code, target) => Object.assign(new Error(`${code}: operation not permitted, rename '${target}'`), { code });
const is = (file) => path.resolve(String(file)) === envFile;
const leftovers = async () => (await readdir(root)).filter((f) => f.startsWith("..env") || f.endsWith(".tmp"));
const saveSource = (label) => http.put("/api/credentials", { mode: "direct", source: { clientId: SRC.clientId, clientSecret: SRC.secret, label } });

// A comment and a key the tool doesn't manage, which a save keeps.
await writeFile(envFile, `# my notes\nOTHER_SETTING=keep me\n${await readFile(envFile, "utf8")}`);

test("a lock on .env that clears within the retries: the wizard's save goes through", async () => {
  let reads = 0;
  let renames = 0;
  fsp.readFile = async (file, ...rest) => {
    if (is(file) && reads++ < 1) throw lockError("EBUSY", file);
    return original.readFile(file, ...rest);
  };
  fsp.rename = async (from, to) => {
    if (is(to) && renames++ < 2) throw lockError("EPERM", to);
    return original.rename(from, to);
  };
  let res;
  try {
    res = await saveSource("Renamed source");
  } finally {
    Object.assign(fsp, original);
  }
  assert.equal(res.status, 200, res.text);
  assert.equal(renames, 3, "renamed on the third try");
  const env = await readFile(envFile, "utf8");
  assert.match(env, /^SOPHOS_SOURCE_LABEL="Renamed source"$/m);
  assert.match(env, /^# my notes$/m);
  assert.match(env, /^OTHER_SETTING="keep me"$/m);
  assert.match(env, new RegExp(`^SOPHOS_DEST_CLIENT_SECRET=${DST.secret}$`, "m"));
  assert.equal(state.getState().source.summary.userLabel, "Renamed source");
  assert.deepEqual(await leftovers(), []);
  assert.ok(getRingBuffer().some((e) => e.section === "credentials" && /replace \.env: EPERM, retry 1\/5/.test(e.message)));
  assert.ok(getRingBuffer().some((e) => e.section === "credentials" && /read \.env: EBUSY, retry 1\/5/.test(e.message)));
});

test(".env is mode 0600 after a save", { skip: windows && "file modes are not enforced on Windows" }, async () => {
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
});

test("a lock that outlasts the retries fails the save clearly and leaves .env as it was", async () => {
  const before = await readFile(envFile, "utf8");
  fsp.rename = async (from, to) => { if (is(to)) throw lockError("EPERM", to); return original.rename(from, to); };
  let res;
  try {
    res = await saveSource("Never saved");
  } finally {
    Object.assign(fsp, original);
  }
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "save_failed");
  assert.equal(res.body.message, "Couldn't save the credentials: .env stayed locked (EPERM), usually by OneDrive or antivirus. Try again.");
  assert.ok(!res.text.includes(SRC.secret) && !res.text.includes(DST.secret));
  assert.equal(await readFile(envFile, "utf8"), before, ".env is as it was");
  assert.deepEqual(await leftovers(), [], "no temp file with the secrets is left");

  const again = await saveSource("Saved after the lock");
  assert.equal(again.status, 200);
  assert.match(await readFile(envFile, "utf8"), /^SOPHOS_SOURCE_LABEL="Saved after the lock"$/m);
});
