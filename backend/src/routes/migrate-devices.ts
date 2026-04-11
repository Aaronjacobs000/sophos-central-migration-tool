/**
 * Routes for the two-tenant device migration flow.
 *   POST   /api/migrate/devices                — start a job
 *   GET    /api/migrate/devices/jobs            — list local jobs
 *   GET    /api/migrate/devices/jobs/:id        — single job detail
 *   GET    /api/migrate/devices/jobs/:id/stream — SSE live updates
 *   DELETE /api/migrate/devices/jobs/:id        — cancel + purge
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import {
  startMigration,
  pollJob,
  cancelJob,
  purgeJob,
} from "../services/device-migrator.js";
import { listJobs, getJob } from "../services/migration-store.js";

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

migrateDevicesRouter.delete("/migrate/devices/jobs/:id", async (req, res, next) => {
  try {
    await cancelJob(req.params.id!);
    if (req.query?.purge === "true") {
      await purgeJob(req.params.id!);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

migrateDevicesRouter.get("/migrate/devices/jobs/:id/stream", async (req, res) => {
  const jobId = req.params.id!;
  const job = await getJob(jobId);
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
      const terminal = ["complete", "failed", "partially-complete", "cancelled"];
      if (terminal.includes(updated.status)) {
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
