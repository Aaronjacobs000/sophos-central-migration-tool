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
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { getState } from "../state.js";
import { registerSecret } from "../log.js";

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

let keyPromise: Promise<Buffer> | null = null;
let keyPromisePath: string | null = null;

/** Reads the key, or creates it the first time (create=true). */
async function loadKey(create: boolean): Promise<Buffer | null> {
  const file = keyFilePath();
  if (keyPromise && keyPromisePath === file) return keyPromise;
  const attempt = (async () => {
    try {
      return decodeKey(await fs.readFile(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw err;
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(file, randomBytes(KEY_BYTES).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    } catch (err) {
      // Another request created it first.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return decodeKey(await fs.readFile(file, "utf8"));
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

async function readVault(): Promise<VaultFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(vaultPath(), "utf8")) as VaultFile;
    return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw err;
  }
}

async function writeVault(vault: VaultFile): Promise<void> {
  const file = vaultPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(vault, null, 2), { encoding: "utf8", mode: 0o600 });
  // mode only applies when the file is created.
  await fs.chmod(file, 0o600).catch(() => {});
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
    const vault = await readVault();
    vault.entries = [...vault.entries.filter((e) => e.id !== id), entry];
    await writeVault(vault);
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
  const entry = await serial(async () => (await readVault()).entries.find((e) => e.id === id));
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
    const vault = await readVault();
    const keep = vault.entries.filter((e) => inUse.has(e.id));
    const removed = vault.entries.length - keep.length;
    if (removed > 0) await writeVault({ version: 1, entries: keep });
    return removed;
  });
}
