/**
 * Encrypted store for the API credentials a migration job needs to check its
 * progress later, after the tool has been pointed at another pair of tenants.
 *
 * data/job-credentials.json holds one entry per distinct API credential,
 * encrypted with AES-256-GCM. Jobs refer to entries by ID, so jobs run with the
 * same credential share one entry, and attaching a new secret for a client ID
 * updates it for every job that uses it. The entry ID is an HMAC of the client
 * ID, so the file does not reveal which client it is for.
 *
 * The 256-bit key is generated on first use and kept outside the repo, by
 * default in ~/.sophos-tenant-migration-tool/job-credentials.key (set
 * JOB_CREDENTIALS_KEY_FILE to move it), created with mode 0600 in a 0700
 * folder. Copying, syncing or sharing data/ therefore does not expose a secret.
 * Anyone who can read both files as this user can decrypt them, the same trust
 * level as the plain-text .env the tool already relies on.
 *
 * The file is saved like the job store's (safe-files.ts): whole, with a copy in
 * data/job-credentials.auto-backup.json that a file cut off by a crash is
 * recovered from, and with retries while OneDrive or antivirus holds it. Both
 * files and the temp file of a save are mode 0600, in data/.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { getState } from "../state.js";
import { log, registerSecret } from "../log.js";
import { isLock, readWithBackup, saveWithBackup, withRetry, type ReadFrom } from "./safe-files.js";

export type CredentialKind = "tenant" | "partner";

export interface ApiCredential {
  clientId: string;
  clientSecret: string;
}

interface VaultEntry {
  id: string;
  kind: CredentialKind;
  updatedAt: string;
  iv: string;
  tag: string;
  data: string;
}

interface VaultFile {
  version: 1;
  entries: VaultEntry[];
}

/** The key file is missing, replaced, or the entry was tampered with. */
export class CredentialUnreadableError extends Error {}

const KEY_BYTES = 32;

export function keyFilePath(): string {
  const override = process.env.JOB_CREDENTIALS_KEY_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".sophos-tenant-migration-tool", "job-credentials.key");
}

function vaultPath(): string {
  return path.join(getState().repoRoot, "data", "job-credentials.json");
}

function vaultBackupPath(): string {
  return path.join(getState().repoRoot, "data", "job-credentials.auto-backup.json");
}

const SECTION = "job-credentials";
const VAULT_MODE = 0o600;

let keyPromise: Promise<Buffer> | null = null;
let keyPromisePath: string | null = null;

/**
 * Reads the key, or creates it the first time (create=true). Each step
 * retries while antivirus or a sync tool holds the file, like the other
 * files the tool keeps (safe-files.ts).
 */
async function loadKey(create: boolean): Promise<Buffer | null> {
  const file = keyFilePath();
  if (keyPromise && keyPromisePath === file) return keyPromise;
  const readKey = async () => decodeKey(await withRetry(SECTION, "read job-credentials.key", () => fs.readFile(file, "utf8")));
  const attempt = (async () => {
    try {
      return await readKey();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw err;
    }
    await withRetry(SECTION, "create the key folder", () => fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }));
    try {
      // "wx" creates the file only if there is none, so two first saves can't write two keys.
      await withRetry(SECTION, "create job-credentials.key", () =>
        fs.writeFile(file, randomBytes(KEY_BYTES).toString("base64") + "\n", { mode: 0o600, flag: "wx" }));
    } catch (err) {
      // Another request created it first.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return readKey();
  })();
  try {
    const key = await attempt;
    keyPromise = Promise.resolve(key);
    keyPromisePath = file;
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function decodeKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new CredentialUnreadableError("The job credential key file is not a 256-bit key.");
  return key;
}

/** Forget the cached key (tests, or after the key file is replaced). */
export function resetKeyCache(): void {
  keyPromise = null;
  keyPromisePath = null;
}

function entryId(key: Buffer, kind: CredentialKind, clientId: string): string {
  return createHmac("sha256", key).update(`${kind}:${clientId}`).digest("hex").slice(0, 32);
}

function parseVault(raw: string): VaultFile {
  const parsed = JSON.parse(raw) as VaultFile;
  return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

/** Why a copy of the vault can't be used. Never the parse error's text, which can quote the file. */
function readProblem(err: unknown): string {
  if (err === undefined) return "is missing";
  const code = (err as NodeJS.ErrnoException).code;
  return code ? `can't be opened (${code})` : "is damaged";
}

let recoveryLogged = false;

/**
 * The vault and where it was read from. When the file is missing or can't be
 * read, the entries come from the backup. With neither, reading fails, so a
 * save never writes over entries it could not read.
 */
async function readVault(): Promise<{ vault: VaultFile; from: ReadFrom }> {
  const read = await readWithBackup(vaultPath(), vaultBackupPath(), parseVault, SECTION);
  if (read.from === "file") {
    recoveryLogged = false;
    return { vault: read.value, from: "file" };
  }
  if (read.from === "none") {
    if (read.fileError === undefined && read.backupError === undefined) return { vault: { version: 1, entries: [] }, from: "none" };
    throw new Error(
      `The stored job credentials can't be read: data/job-credentials.json ${readProblem(read.fileError)}, ` +
        `and ${read.backupError === undefined ? "there is no backup" : `the backup ${readProblem(read.backupError)}`}.`,
    );
  }
  if (!recoveryLogged) {
    recoveryLogged = true;
    log.emit("warn", SECTION, `data/job-credentials.json ${readProblem(read.fileError)}, so the ${read.value.entries.length} stored credentials in data/job-credentials.auto-backup.json were used. The next save rewrites it.`);
  }
  return { vault: read.value, from: "backup" };
}

async function writeVault(vault: VaultFile, from: ReadFrom): Promise<void> {
  const file = vaultPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await saveWithBackup(file, vaultBackupPath(), JSON.stringify(vault, null, 2), from, { section: SECTION, mode: VAULT_MODE, failed: saveError });
}

/** An error that says the credentials were not saved, and for a lock, what usually holds the file. */
function saveError(err: unknown, file: string): Error {
  const reason = isLock(err)
    ? `data/${path.basename(file)} stayed locked (${(err as NodeJS.ErrnoException).code}), usually by OneDrive or antivirus. Try again`
    : err instanceof Error ? err.message : String(err);
  return new Error(`Couldn't save the job credentials: ${reason}.`, { cause: err });
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Store a credential (or replace the secret for its client ID). Returns its entry ID. */
export function putCredential(kind: CredentialKind, cred: ApiCredential): Promise<string> {
  registerSecret(cred.clientSecret);
  return serial(async () => {
    const key = (await loadKey(true))!;
    const id = entryId(key, kind, cred.clientId);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${id}:${kind}`));
    const data = Buffer.concat([cipher.update(JSON.stringify({ clientId: cred.clientId, clientSecret: cred.clientSecret }), "utf8"), cipher.final()]);
    const entry: VaultEntry = {
      id,
      kind,
      updatedAt: new Date().toISOString(),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    const { vault, from } = await readVault();
    vault.entries = [...vault.entries.filter((e) => e.id !== id), entry];
    await writeVault(vault, from);
    return id;
  });
}

/**
 * Decrypt one entry. Null when the entry is gone; CredentialUnreadableError
 * when the key is missing or does not match (the data folder was moved to
 * another computer, or the key file was deleted).
 */
export async function getCredential(id: string): Promise<(ApiCredential & { kind: CredentialKind }) | null> {
  // Queued behind saves, which rewrite the file: a read mid-save gets half of it.
  const entry = await serial(async () => (await readVault()).vault.entries.find((e) => e.id === id));
  if (!entry) return null;
  const key = await loadKey(false);
  if (!key) throw new CredentialUnreadableError("The key for the stored credentials is missing on this computer.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
    decipher.setAAD(Buffer.from(`${entry.id}:${entry.kind}`));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
    const cred = JSON.parse(plain) as ApiCredential;
    registerSecret(cred.clientSecret);
    return { ...cred, kind: entry.kind };
  } catch {
    throw new CredentialUnreadableError("The stored credentials can't be decrypted with the key on this computer.");
  }
}

/** Drop every entry no job refers to. Returns how many were removed. */
export function pruneCredentials(inUse: Set<string>): Promise<number> {
  return serial(async () => {
    const { vault, from } = await readVault();
    const keep = vault.entries.filter((e) => inUse.has(e.id));
    const removed = vault.entries.length - keep.length;
    if (removed > 0) await writeVault({ version: 1, entries: keep }, from);
    return removed;
  });
}
