/**
 * The one shape a migration job leaves the server in. Every route and the
 * live stream send jobs through publicJob, so the credential references
 * (entry IDs into the encrypted store) never reach the browser; the page only
 * learns whether credentials are stored.
 */

import { jobProgress, type JobProgress } from "./job-progress.js";
import type { JobStatus, LocalMigrationJob } from "./migration-store.js";

export interface PublicJob extends Omit<LocalMigrationJob, "credentials" | "status"> {
  status: JobStatus;
  credentials: { stored: boolean; mode?: "direct" | "partner"; storedAt?: string };
  progress: JobProgress;
}

export function publicJob(job: LocalMigrationJob, now: number = Date.now()): PublicJob {
  const { credentials, ...rest } = job;
  const progress = jobProgress(job, now);
  return {
    ...rest,
    status: progress.status,
    credentials: credentials
      ? { stored: true, mode: credentials.mode, storedAt: credentials.storedAt }
      : { stored: false },
    progress,
  };
}
