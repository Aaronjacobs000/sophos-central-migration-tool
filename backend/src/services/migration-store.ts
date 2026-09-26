/**
 * Local persistence for device-migration jobs. Each entry tracks the
 * IDs of the source and destination Sophos migration jobs plus a snapshot
 * of the last polled state, so the UI can resume monitoring after restart.
 *
 * Stored as a single JSON file at data/migration-jobs.json, with a copy in
 * data/migration-jobs.auto-backup.json that a jobs file cut off by a crash is
 * recovered from (see writeAll). The copy's name keeps it apart from a manual
 * backup, which the tool would otherwise overwrite on its next save.
 *
 * File operations retry on EBUSY / EPERM / EACCES: OneDrive (and other
 * cloud-sync tools) and antivirus briefly lock files, which causes transient
 * failures on Windows.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getState } from "../state.js";
import { log } from "../log.js";
import type { SophosMigrationJob } from "../sophos/types/migration.js";

export interface EndpointGroupRef {
  id?: string;
  name: string;
}

/**
 * Where a device is on the receiving tenant. Sophos hands a device over within
 * seconds, but the device only moves when it next checks in, under its new ID.
 */
export interface DeviceCheckIn {
  state: "not-moved" | "move-failed" | "waiting" | "checked-in";
  /** The device's ID on the receiving tenant, from the migration job. */
  newId?: string;
  /** When Sophos reported the device moved (migratedAt). */
  handedOverAt?: string;
  /**
   * The device's last-seen time when the tool first found it checked in. The
   * device had checked in by then; with the job page open during the move it is
   * within one poll of the first check-in.
   */
  checkedInAt?: string;
}

/**
 * A tenant a job ran against, recorded when the job is created (or when
 * credentials are attached to an older job), so the job keeps checking the
 * same tenants after the tool is pointed at another pair.
 */
export interface JobTenant {
  tenantId: string;
  /** Display name at the time: the label, or the tenant name in partner mode. */
  name: string | null;
  /** Regional data host, for example https://api-eu02.central.sophos.com. */
  apiHost: string;
  region: string | null;
}

/**
 * References into the encrypted job credential store (job-credentials.ts).
 * No secret is kept in the job itself. In partner mode both sides refer to
 * the same partner credential.
 */
export interface JobCredentialRefs {
  mode: "direct" | "partner";
  source: string;
  dest: string;
  storedAt: string;
}

/**
 * How the last check of a job went. A failed check never replaces the saved
 * snapshots or check-ins; it only changes this.
 */
export interface JobMonitor {
  /**
   * ok: both tenants answered. rejected: Sophos refused the credentials
   * (deleted, rotated or no longer allowed). no-credentials: nothing to check
   * with. not-found: an older job with no recorded tenants was not found on the
   * tenants the tool points at. error: any other failure, retried.
   */
  state: "ok" | "rejected" | "no-credentials" | "not-found" | "error";
  /** Where the credentials for the last check came from. */
  via?: "stored" | "current";
  message?: string;
  /** Last check that reached both tenants. */
  lastOkAt?: string;
  lastTriedAt?: string;
}

/**
 * Job status, from the devices: requested once Sophos has accepted the job,
 * in-progress once one device has checked in on the receiving tenant,
 * completed once all have. A job where every device has arrived or failed
 * ends completed-with-failures (some arrived) or failed (none did).
 */
export type JobStatus =
  | "requested"
  | "in-progress"
  | "completed"
  | "completed-with-failures"
  | "failed"
  | "cancelled";

export interface LocalMigrationJob {
  localJobId: string;
  jobName: string;
  createdAt: string;
  /** "source-to-dest" or "dest-to-source" */
  direction: string;
  sourceMigrationId: string;
  destMigrationId: string;
  endpointIds: string[];
  endpointHostnames: Record<string, string>;
  /**
   * The group each device was in on the sending tenant when the job was
   * created (null for no group). Absent on jobs created before 0.2.0.
   */
  endpointGroups?: Record<string, EndpointGroupRef | null>;
  /** Check-in on the receiving tenant, by the device's ID on the sending tenant. */
  checkIns?: Record<string, DeviceCheckIn>;
  /**
   * Derived from the devices on every check (job-progress.ts). Jobs saved by
   * earlier versions may hold "complete", "in-progress" or "partially-complete",
   * which meant the handover only; they are recomputed when read.
   */
  status: JobStatus | "complete" | "partially-complete";
  sourceSnapshot: SophosMigrationJob | null;
  destSnapshot: SophosMigrationJob | null;
  /** The tenants the job ran against. Absent on jobs created by earlier builds. */
  tenants?: { source: JobTenant; dest: JobTenant };
  /** Stored credentials for checking the job later. Absent when none are stored. */
  credentials?: JobCredentialRefs;
  monitor?: JobMonitor;
  lastPolledAt?: string;
  lastError?: string;
}

/**
 * The receiver job's handshake token is a secret, needed only for the sender
 * trigger. It is never stored, and both tenants return it on every job GET, so
 * it is dropped from the API snapshots too. Jobs saved by earlier versions
 * (field fromToken) lose it on the next read and write.
 */
function withoutTokens(job: LocalMigrationJob): LocalMigrationJob {
  const { fromToken: _legacy, ...rest } = job as LocalMigrationJob & { fromToken?: string };
  return { ...rest, sourceSnapshot: snapshotWithoutToken(rest.sourceSnapshot), destSnapshot: snapshotWithoutToken(rest.destSnapshot) };
}

function snapshotWithoutToken(snap: SophosMigrationJob | null | undefined): SophosMigrationJob | null {
  if (!snap) return null;
  const { token: _token, fromToken: _fromToken, ...rest } = snap;
  return rest;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run one read or save at a time, so a read never meets a save half done. A
 * call that fails fails alone: the next one still runs.
 */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function jobsFile(): string {
  return path.join(getState().repoRoot, "data", "migration-jobs.json");
}

function backupFile(): string {
  return path.join(getState().repoRoot, "data", "migration-jobs.auto-backup.json");
}

/** Codes that indicate a transient file lock (OneDrive, antivirus, etc.). */
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_RETRIES = 5;
let baseDelayMs = 150;

/** The wait before the first retry on a locked file, doubled for each one after. Tests shorten it. */
export function setRetryDelay(ms: number): void {
  baseDelayMs = ms;
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && RETRYABLE_CODES.has(code) && attempt < MAX_RETRIES) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        log.emit("warn", "migration-store", `${label}: ${code}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function isLock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return !!code && RETRYABLE_CODES.has(code);
}

/** A file's text, or null when there is no such file. */
async function readText(file: string): Promise<string | null> {
  try {
    return await withRetry(`read ${path.basename(file)}`, () => fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function parseJobs(raw: string): LocalMigrationJob[] {
  const jobs = JSON.parse(raw) as unknown;
  if (!Array.isArray(jobs)) throw new Error("not a list of jobs");
  return (jobs as LocalMigrationJob[]).map(withoutTokens);
}

function readProblem(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return code ? `can't be opened (${code})` : `is damaged (${err instanceof Error ? err.message : String(err)})`;
}

/** Where the jobs were read from: the jobs file, its backup, or neither (no jobs saved yet). */
type ReadFrom = "file" | "backup" | "none";

let recoveryLogged = false;

/**
 * The saved jobs. When the jobs file is missing or can't be read (cut off by a
 * crash mid-save, or held by another program), they come from the backup,
 * which holds the last save or a newer one. With neither, reading fails, so a
 * save never writes over jobs it could not read.
 */
async function readAll(): Promise<{ jobs: LocalMigrationJob[]; from: ReadFrom }> {
  let problem: string | null = null;
  try {
    const raw = await readText(jobsFile());
    if (raw !== null) {
      const jobs = parseJobs(raw);
      recoveryLogged = false;
      return { jobs, from: "file" };
    }
  } catch (err) {
    problem = readProblem(err);
  }
  let backup: LocalMigrationJob[] | null = null;
  let backupProblem: string | null = null;
  try {
    const raw = await readText(backupFile());
    if (raw !== null) backup = parseJobs(raw);
  } catch (err) {
    backupProblem = readProblem(err);
  }
  if (!backup) {
    if (!problem && !backupProblem) return { jobs: [], from: "none" };
    throw new Error(
      `The migration jobs can't be read: data/migration-jobs.json ${problem ?? "is missing"}, ` +
        `and ${backupProblem ? `the backup ${backupProblem}` : "there is no backup"}.`,
    );
  }
  if (!recoveryLogged) {
    recoveryLogged = true;
    log.emit("warn", "migration-store", `data/migration-jobs.json ${problem ?? "is missing"}, so the ${backup.length} jobs in data/migration-jobs.auto-backup.json were used. The next save rewrites it.`);
  }
  return { jobs: backup, from: "backup" };
}

/** Write a file and flush it to disk. */
async function writeFlushed(file: string, text: string): Promise<void> {
  const handle = await fs.open(file, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Save a file whole: write a temp file beside it, then rename it over the
 * file, so a crash leaves the old file or the new one and a reader never sees
 * part of one. OneDrive and antivirus can hold the file on Windows, which
 * makes the rename fail even when a write would succeed. If the rename is
 * still locked after its retries and inPlaceIsSafe() agrees, the file is
 * written in place instead, as earlier versions always did.
 */
async function saveFile(file: string, text: string, inPlaceIsSafe: () => Promise<boolean>): Promise<void> {
  const name = path.basename(file);
  const temp = path.join(path.dirname(file), `.${name}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  try {
    await withRetry(`write ${name} (temp file)`, () => writeFlushed(temp, text));
    await withRetry(`replace ${name}`, () => fs.rename(temp, file));
    return;
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    if (!isLock(err) || !(await inPlaceIsSafe())) throw saveError(err, name);
    log.emit("warn", "migration-store", `${name} stayed locked (${(err as NodeJS.ErrnoException).code}), so it was written in place.`);
  }
  try {
    await withRetry(`write ${name}`, () => writeFlushed(file, text));
  } catch (err) {
    throw saveError(err, name);
  }
}

/**
 * Save the jobs: the backup first, then the jobs file, so the backup always
 * holds the last save or a newer one. The backup is written in place only
 * while the jobs file holds a whole list, and the jobs file only once the
 * backup holds this one, so one of the two is always whole.
 */
async function writeAll(jobs: LocalMigrationJob[], from: ReadFrom): Promise<void> {
  const text = JSON.stringify(jobs, null, 2);
  try {
    await fs.mkdir(path.dirname(jobsFile()), { recursive: true });
  } catch (err) {
    throw saveError(err, "data");
  }
  await saveFile(backupFile(), text, async () => from !== "backup");
  await saveFile(jobsFile(), text, async () => (await readText(backupFile()).catch(() => null)) === text);
}

/** An error that says the jobs were not saved, and for a lock, what usually holds the file. */
function saveError(err: unknown, name: string): Error {
  const reason = isLock(err)
    ? `data/${name} stayed locked (${(err as NodeJS.ErrnoException).code}), usually by OneDrive or antivirus. Try again`
    : err instanceof Error ? err.message : String(err);
  return new Error(`Couldn't save the migration jobs: ${reason}.`, { cause: err });
}

export async function listJobs(): Promise<LocalMigrationJob[]> {
  return serial(async () => (await readAll()).jobs);
}

export async function getJob(localJobId: string): Promise<LocalMigrationJob | null> {
  return serial(async () => (await readAll()).jobs.find((j) => j.localJobId === localJobId) ?? null);
}

export async function createJob(
  init: Omit<LocalMigrationJob, "localJobId" | "createdAt" | "status" | "sourceSnapshot" | "destSnapshot">,
): Promise<LocalMigrationJob> {
  const job: LocalMigrationJob = withoutTokens({
    localJobId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "requested",
    sourceSnapshot: null,
    destSnapshot: null,
    ...init,
  });

  await serial(async () => {
    const { jobs, from } = await readAll();
    jobs.unshift(job);
    await writeAll(jobs, from);
  });
  return job;
}

export async function updateJob(
  localJobId: string,
  patch: Partial<LocalMigrationJob>,
): Promise<LocalMigrationJob | null> {
  return serial(async () => {
    const { jobs, from } = await readAll();
    const idx = jobs.findIndex((j) => j.localJobId === localJobId);
    if (idx < 0) return null;
    jobs[idx] = withoutTokens({ ...jobs[idx]!, ...patch });
    await writeAll(jobs, from);
    return jobs[idx]!;
  });
}

export async function deleteJob(localJobId: string): Promise<void> {
  await serial(async () => {
    const { jobs, from } = await readAll();
    const filtered = jobs.filter((j) => j.localJobId !== localJobId);
    await writeAll(filtered, from);
  });
}
