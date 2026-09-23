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

export interface LocalMigrationJob {
  localJobId: string;
  jobName: string;
  createdAt: string;
  /** "source-to-dest" or "dest-to-source" */
  direction: string;
  sourceMigrationId: string;
  destMigrationId: string;
  fromToken: string;
  endpointIds: string[];
  endpointHostnames: Record<string, string>;
  /**
   * The group each device was in on the sending tenant when the job was
   * created (null for no group). Absent on jobs created before 0.2.0.
   */
  endpointGroups?: Record<string, EndpointGroupRef | null>;
  status: "in-progress" | "complete" | "failed" | "partially-complete" | "cancelled";
  sourceSnapshot: SophosMigrationJob | null;
  destSnapshot: SophosMigrationJob | null;
  lastPolledAt?: string;
  lastError?: string;
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
    return JSON.parse(raw) as LocalMigrationJob[];
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
  const job: LocalMigrationJob = {
    localJobId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "in-progress",
    sourceSnapshot: null,
    destSnapshot: null,
    ...init,
  };

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
    jobs[idx] = { ...jobs[idx]!, ...patch };
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
