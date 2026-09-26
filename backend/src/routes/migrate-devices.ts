/**
 * Routes for the two-tenant device migration flow.
 *   POST   /api/migrate/devices                          start a job
 *   GET    /api/migrate/devices/jobs                     list local jobs
 *   GET    /api/migrate/devices/jobs/all                 merged local + API jobs
 *   GET    /api/migrate/devices/jobs/:id                 single job detail
 *   GET    /api/migrate/devices/jobs/:id/stream          SSE live updates
 *   POST   /api/migrate/devices/jobs/:id/group-membership  put moved devices
 *          back into same-named groups (dryRun supported)
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import {
  startMigration,
  pollJob,
} from "../services/device-migrator.js";
import { listJobs, getJob } from "../services/migration-store.js";
import { awaitingCheckIn } from "../services/device-check-in.js";
import { restoreGroupMembership, JobNotFoundError } from "../services/group-membership.js";
import { listMigrationJobs } from "../sophos/api/migrations.js";
import { requireContext } from "../state.js";
import type { SophosMigrationJob } from "../sophos/types/migration.js";
import type { LocalMigrationJob } from "../services/migration-store.js";

export const migrateDevicesRouter = Router();

migrateDevicesRouter.use("/migrate/devices", requireConfigured);

migrateDevicesRouter.post("/migrate/devices", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.endpointIds) ? req.body.endpointIds : [];
    const jobName = String(req.body?.jobName ?? "").trim();
    const dryRun = req.query?.dryRun === "true" || req.body?.dryRun === true;
    const direction = req.body?.direction === "dest-to-source" ? "dest-to-source" : "source-to-dest";
    if (!ids.length || !jobName) {
      res.status(400).json({
        error: "bad_request",
        message: "endpointIds[] and jobName are required",
      });
      return;
    }
    const result = await startMigration({
      jobName,
      endpointIds: ids,
      direction,
      dryRun,
    });
    if (result.settingFailure) {
      res.status(400).json({ error: "migration_not_allowed", message: result.settingFailure });
      return;
    }
    if (result.preflightFailures.length > 0) {
      res.status(400).json({
        error: "preflight_failed",
        preflightFailures: result.preflightFailures,
      });
      return;
    }
    if (result.plan) {
      res.json({ ok: true, dryRun: true, plan: result.plan });
      return;
    }
    res.status(201).json({ ok: true, job: result.job });
  } catch (err) {
    next(err);
  }
});

migrateDevicesRouter.get("/migrate/devices/jobs", async (_req, res, next) => {
  try {
    const jobs = await listJobs();
    res.json({ items: jobs });
  } catch (err) {
    next(err);
  }
});

/**
 * Merged view: local jobs + all migration jobs from both tenants' APIs.
 * API-only jobs (triggered outside this tool) are included so users can
 * see the full picture of what's been requested across any platform.
 */
migrateDevicesRouter.get("/migrate/devices/jobs/all", async (_req, res, next) => {
  try {
    const src = requireContext("source");
    const dst = requireContext("dest");

    const [localJobs, srcApiJobs, dstApiJobs] = await Promise.all([
      listJobs(),
      listMigrationJobs(src.client, src.tenantId).catch((): SophosMigrationJob[] => []),
      listMigrationJobs(dst.client, dst.tenantId).catch((): SophosMigrationJob[] => []),
    ]);

    // Index local jobs by their upstream Sophos migration IDs for correlation
    const localBySourceId = new Map<string, LocalMigrationJob>();
    const localByDestId = new Map<string, LocalMigrationJob>();
    for (const lj of localJobs) {
      localBySourceId.set(lj.sourceMigrationId, lj);
      localByDestId.set(lj.destMigrationId, lj);
    }

    // Track which API job IDs are already covered by a local job
    const coveredApiIds = new Set<string>();
    const merged: MergedMigrationJob[] = [];

    // 1. Start with all local jobs; they get full detail
    for (const lj of localJobs) {
      coveredApiIds.add(lj.sourceMigrationId);
      coveredApiIds.add(lj.destMigrationId);
      merged.push({
        origin: "local",
        localJobId: lj.localJobId,
        jobName: lj.jobName,
        status: lj.status,
        direction: lj.direction,
        endpointCount: lj.endpointIds.length,
        createdAt: lj.createdAt,
        sourceMigrationId: lj.sourceMigrationId,
        destMigrationId: lj.destMigrationId,
        sourceSnapshot: lj.sourceSnapshot,
        destSnapshot: lj.destSnapshot,
        lastPolledAt: lj.lastPolledAt,
      });
    }

    // 2. Add API-only jobs from the source tenant
    for (const aj of srcApiJobs) {
      if (coveredApiIds.has(aj.id)) continue;
      coveredApiIds.add(aj.id);
      merged.push(apiJobToMerged(aj, "source", src.summary.displayName));
    }

    // 3. Add API-only jobs from the dest tenant
    for (const aj of dstApiJobs) {
      if (coveredApiIds.has(aj.id)) continue;
      coveredApiIds.add(aj.id);
      merged.push(apiJobToMerged(aj, "dest", dst.summary.displayName));
    }

    // Sort newest first
    merged.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    res.json({ items: merged });
  } catch (err) {
    next(err);
  }
});

migrateDevicesRouter.get("/migrate/devices/jobs/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Refresh once on detail load so the cached snapshot is up-to-date.
    const updated = await pollJob(req.params.id!).catch(() => job);
    res.json(updated ?? job);
  } catch (err) {
    next(err);
  }
});

migrateDevicesRouter.post("/migrate/devices/jobs/:id/group-membership", async (req, res, next) => {
  try {
    const dryRun = req.query?.dryRun === "true" || req.body?.dryRun === true;
    res.json(await restoreGroupMembership(req.params.id!, { dryRun }));
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      res.status(404).json({ error: "not_found", message: err.message });
      return;
    }
    next(err);
  }
});

migrateDevicesRouter.get("/migrate/devices/jobs/:id/stream", async (req, res) => {
  const jobId = req.params.id!;
  let job;
  try {
    job = await getJob(jobId);
  } catch (err) {
    res.status(500).json({
      error: "store_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!job) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let cancelled = false;
  const send = (event: string, data: unknown) => {
    if (cancelled) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial snapshot immediately
  send("status", job);

  const tick = async () => {
    if (cancelled) return;
    try {
      const updated = await pollJob(jobId);
      if (!updated) {
        send("done", { reason: "job_deleted" });
        cancelled = true;
        res.end();
        return;
      }
      send("status", updated);
      // A handed-over device is followed until it checks in on the receiving tenant.
      const terminal = ["complete", "failed", "partially-complete", "cancelled"];
      if (terminal.includes(updated.status) && !awaitingCheckIn(updated)) {
        send("done", { status: updated.status });
        cancelled = true;
        res.end();
        return;
      }
    } catch (err) {
      send("error", { message: err instanceof Error ? err.message : String(err) });
    }
    if (!cancelled) setTimeout(tick, 10_000);
  };

  // Start the polling loop a beat after the initial snapshot.
  setTimeout(tick, 1500);

  req.on("close", () => {
    cancelled = true;
  });
});

// --- Merged job type used by the /all endpoint ---

export interface MergedMigrationJob {
  /** "local" = created by this tool; "api" = discovered from the Sophos API */
  origin: "local" | "api";
  localJobId?: string;
  jobName: string;
  status: string;
  direction?: string;
  endpointCount?: number;
  createdAt?: string;
  sourceMigrationId?: string;
  destMigrationId?: string;
  sourceSnapshot?: SophosMigrationJob | null;
  destSnapshot?: SophosMigrationJob | null;
  lastPolledAt?: string;
  /** For API-only jobs: which tenant ("source" or "dest") reported this job */
  apiTenant?: string;
  /** For API-only jobs: the display name of the tenant */
  apiTenantName?: string | null;
  /** For API-only jobs: the Sophos migration ID */
  apiMigrationId?: string;
  /** For API-only jobs: sender or receiver */
  apiJobMode?: string;
}

function apiJobToMerged(
  aj: SophosMigrationJob,
  tenant: "source" | "dest",
  tenantName: string | null | undefined,
): MergedMigrationJob {
  return {
    origin: "api",
    jobName: aj.name || `API job ${aj.id.slice(0, 8)}`,
    status: aj.status ?? "unknown",
    endpointCount: aj.endpointCounts?.total ?? undefined,
    createdAt: aj.createdAt,
    apiTenant: tenant,
    apiTenantName: tenantName ?? null,
    apiMigrationId: aj.id,
    apiJobMode: aj.mode ?? aj.type ?? undefined,
  };
}
