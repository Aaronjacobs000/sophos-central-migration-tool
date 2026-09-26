/**
 * Local persistence for device-migration jobs. Each entry tracks the
 * IDs of the source and destination Sophos migration jobs plus a snapshot
 * of the last polled state, so the UI can resume monitoring after restart.
 *
 * Stored as a single JSON file at data/migration-jobs.json.
 *
 * File operations retry on EBUSY / EPERM: OneDrive (and other cloud-sync
 * tools) briefly lock files during upload, which causes transient failures
 * on Windows.
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

let writeQueue: Promise<void> = Promise.resolve();

function jobsFile(): string {
  return path.join(getState().repoRoot, "data", "migration-jobs.json");
}

/** Codes that indicate a transient file lock (OneDrive, antivirus, etc.). */
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 150;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && RETRYABLE_CODES.has(code) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        log.emit("warn", "migration-store", `${label}: ${code}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function readAll(): Promise<LocalMigrationJob[]> {
  try {
    const raw = await withRetry("readAll", () => fs.readFile(jobsFile(), "utf8"));
    return (JSON.parse(raw) as LocalMigrationJob[]).map(withoutTokens);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(jobs: LocalMigrationJob[]): Promise<void> {
  const file = jobsFile();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  await withRetry("writeAll", async () => {
    // Write directly instead of tmp+rename. OneDrive can lock the target
    // during sync, which makes the rename fail even if the write succeeds.
    await fs.writeFile(file, JSON.stringify(jobs, null, 2), "utf8");
  });
}

export async function listJobs(): Promise<LocalMigrationJob[]> {
  return readAll();
}

export async function getJob(localJobId: string): Promise<LocalMigrationJob | null> {
  const jobs = await readAll();
  return jobs.find((j) => j.localJobId === localJobId) ?? null;
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

  writeQueue = writeQueue.then(async () => {
    const jobs = await readAll();
    jobs.unshift(job);
    await writeAll(jobs);
  });
  await writeQueue;
  return job;
}

export async function updateJob(
  localJobId: string,
  patch: Partial<LocalMigrationJob>,
): Promise<LocalMigrationJob | null> {
  let updated: LocalMigrationJob | null = null;
  writeQueue = writeQueue.then(async () => {
    const jobs = await readAll();
    const idx = jobs.findIndex((j) => j.localJobId === localJobId);
    if (idx < 0) return;
    jobs[idx] = withoutTokens({ ...jobs[idx]!, ...patch });
    updated = jobs[idx]!;
    await writeAll(jobs);
  });
  await writeQueue;
  return updated;
}

export async function deleteJob(localJobId: string): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const jobs = await readAll();
    const filtered = jobs.filter((j) => j.localJobId !== localJobId);
    await writeAll(filtered);
  });
  await writeQueue;
}
