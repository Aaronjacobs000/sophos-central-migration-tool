/**
 * Two-tenant device migration orchestration.
 *
 * Workflow:
 *   1. Preflight: read each selected source endpoint, reject any that
 *      haven't checked in within the last 14 days.
 *   2. Create receiving job on DESTINATION → returns id + token.
 *   3. Create sending job on SOURCE with the dest token + endpoint IDs.
 *   4. Persist both job IDs to data/migration-jobs.json.
 *   5. UI subscribes via SSE to /api/migrate/devices/jobs/:id/stream.
 */

import { requireContext } from "../state.js";
import {
  getEndpoint,
} from "../sophos/api/endpoints.js";
import {
  createMigrationJob,
  deleteMigrationJob,
  getMigrationJob,
  listMigrationJobEndpoints,
} from "../sophos/api/migrations.js";
import {
  createJob,
  deleteJob,
  getJob,
  updateJob,
  type LocalMigrationJob,
} from "./migration-store.js";
import { audit } from "./audit-log.js";
import { log } from "../log.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export type MigrationDirection = "source-to-dest" | "dest-to-source";

export interface StartMigrationRequest {
  jobName: string;
  endpointIds: string[];
  /** Direction: default "source-to-dest". Set "dest-to-source" to reverse. */
  direction?: MigrationDirection;
  dryRun?: boolean;
}

export interface PreflightFailure {
  endpointId: string;
  hostname?: string;
  reason: string;
}

export interface StartMigrationResult {
  preflightFailures: PreflightFailure[];
  /** Present in dry-run mode: the plan we would execute. */
  plan?: {
    sourceTenantId: string;
    sourceApiHost: string;
    destTenantId: string;
    destApiHost: string;
    receiverBody: { name: string; fromTenant: string; endpoints: string[] };
    senderBody: { name: string; fromTenant: string; endpoints: string[]; token: string };
  };
  /** Present in real run: the persisted local job. */
  job?: LocalMigrationJob;
}

export async function startMigration(
  req: StartMigrationRequest,
): Promise<StartMigrationResult> {
  const direction: MigrationDirection = req.direction ?? "source-to-dest";

  // "from" is the side that owns the devices (sender).
  // "to" is the side receiving the devices (receiver).
  const from = requireContext(direction === "source-to-dest" ? "source" : "dest");
  const to = requireContext(direction === "source-to-dest" ? "dest" : "source");

  if (!req.jobName?.trim()) throw new Error("jobName is required");
  if (!Array.isArray(req.endpointIds) || req.endpointIds.length === 0) {
    throw new Error("endpointIds[] is required");
  }

  // Sanitise: strip any accidental prefixes (e.g. "source::uuid") and
  // validate that every ID looks like a UUID before we send them to Sophos.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const cleanIds = req.endpointIds.map((id) => {
    // Strip "source::" or "dest::" prefix if accidentally passed through
    const stripped = id.replace(/^(source|dest)::/, "").trim();
    return stripped;
  });
  const invalidIds = cleanIds.filter((id) => !UUID_RE.test(id));
  if (invalidIds.length > 0) {
    throw new Error(
      `${invalidIds.length} endpoint ID(s) are not valid UUIDs: ${invalidIds.slice(0, 3).join(", ")}${invalidIds.length > 3 ? "…" : ""}`,
    );
  }
  // Replace req.endpointIds with the cleaned version
  req.endpointIds = cleanIds;

  // Step 1 — preflight: load each endpoint from the "from" side
  const preflightFailures: PreflightFailure[] = [];
  const acceptedEndpoints: SophosEndpoint[] = [];
  for (const id of req.endpointIds) {
    let ep: SophosEndpoint;
    try {
      ep = await getEndpoint(from.client, from.tenantId, id);
    } catch (err) {
      preflightFailures.push({
        endpointId: id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!ep.lastSeenAt || Date.now() - new Date(ep.lastSeenAt).getTime() > FOURTEEN_DAYS_MS) {
      preflightFailures.push({
        endpointId: id,
        hostname: ep.hostname,
        reason: "outside the 14-day check-in window",
      });
      continue;
    }
    acceptedEndpoints.push(ep);
  }

  if (preflightFailures.length > 0) return { preflightFailures };

  const endpointIds = acceptedEndpoints.map((e) => e.id);

  if (req.dryRun) {
    return {
      preflightFailures: [],
      plan: {
        sourceTenantId: from.tenantId,
        sourceApiHost: from.summary.apiHost,
        destTenantId: to.tenantId,
        destApiHost: to.summary.apiHost,
        receiverBody: {
          name: req.jobName,
          fromTenant: from.tenantId,
          endpoints: endpointIds,
        },
        senderBody: {
          name: req.jobName,
          fromTenant: to.tenantId,
          endpoints: endpointIds,
          token: "<would be returned by receiver job>",
        },
      },
    };
  }

  // Step 2 — create receiver on the "to" side.
  // Sophos requires: name + fromTenant (who's sending) + endpoints (which devices).
  const receiver = await createMigrationJob(to.client, to.tenantId, {
    name: req.jobName,
    fromTenant: from.tenantId,
    endpoints: endpointIds,
  });
  // Sophos returns the handshake token as `token` (not `fromToken`).
  const handshakeToken = (receiver as any).token ?? receiver.fromToken;
  if (!handshakeToken) {
    throw new Error("Receiver job did not return a handshake token");
  }
  await audit({
    side: to.label,
    tenantId: to.tenantId,
    action: "create",
    resource: "migration-receiver",
    resourceId: receiver.id,
    ok: true,
    detail: { jobName: req.jobName, direction },
  });

  // Step 3 — create sender on the "from" side.
  // Sophos requires: name + fromTenant (where devices go) + endpoints + token.
  const senderBody = {
    name: req.jobName,
    fromTenant: to.tenantId,
    endpoints: endpointIds,
    token: handshakeToken,
  };
  log.emit("info", "migration", `Creating sender job: ${endpointIds.length} endpoint(s), fromTenant=${to.tenantId}`, {
    side: from.label as "source" | "dest",
  });
  let sender;
  try {
    sender = await createMigrationJob(from.client, from.tenantId, senderBody);
    await audit({
      side: from.label,
      tenantId: from.tenantId,
      action: "create",
      resource: "migration-sender",
      resourceId: sender.id,
      ok: true,
      detail: {
        jobName: req.jobName,
        direction,
        endpointCount: acceptedEndpoints.length,
        receiverId: receiver.id,
      },
    });
  } catch (err) {
    try { await deleteMigrationJob(to.client, to.tenantId, receiver.id); } catch { /* best-effort */ }
    throw err;
  }

  // Step 4 — persist locally
  const job = await createJob({
    jobName: req.jobName,
    sourceMigrationId: sender.id,
    destMigrationId: receiver.id,
    fromToken: handshakeToken,
    endpointIds: acceptedEndpoints.map((e) => e.id),
    endpointHostnames: Object.fromEntries(
      acceptedEndpoints.map((e) => [e.id, e.hostname ?? ""]),
    ),
    direction,
  });

  return { preflightFailures: [], job };
}

/**
 * Poll both source and destination for the given local job and merge the
 * results. Updates the local store and returns the latest snapshot.
 */
export async function pollJob(localJobId: string): Promise<LocalMigrationJob | null> {
  const job = await getJob(localJobId);
  if (!job) return null;

  const src = requireContext("source");
  const dst = requireContext("dest");

  const [srcJob, dstJob, srcEndpoints, dstEndpoints] = await Promise.all([
    safe(() => getMigrationJob(src.client, src.tenantId, job.sourceMigrationId)),
    safe(() => getMigrationJob(dst.client, dst.tenantId, job.destMigrationId)),
    safe(() => listMigrationJobEndpoints(src.client, src.tenantId, job.sourceMigrationId)),
    safe(() => listMigrationJobEndpoints(dst.client, dst.tenantId, job.destMigrationId)),
  ]);

  // Decide aggregate status
  const status = aggregateStatus(srcJob.value, dstJob.value, job.status);

  const updated = await updateJob(localJobId, {
    sourceSnapshot: srcJob.value
      ? {
          ...srcJob.value,
          // Stash per-endpoint statuses on the snapshot for the UI.
          // (Not part of the upstream type but useful for clients.)
          // @ts-expect-error - extending shape for client use
          endpointDetails: srcEndpoints.value ?? [],
        }
      : null,
    destSnapshot: dstJob.value
      ? {
          ...dstJob.value,
          // @ts-expect-error - extending shape for client use
          endpointDetails: dstEndpoints.value ?? [],
        }
      : null,
    status,
    lastPolledAt: new Date().toISOString(),
    lastError: srcJob.error ?? dstJob.error,
  });

  return updated;
}

/**
 * Cancel a local job by deleting both upstream sender and receiver
 * migration jobs and marking the local entry as cancelled.
 */
export async function cancelJob(localJobId: string): Promise<void> {
  const job = await getJob(localJobId);
  if (!job) return;
  const src = requireContext("source");
  const dst = requireContext("dest");

  await Promise.allSettled([
    deleteMigrationJob(src.client, src.tenantId, job.sourceMigrationId),
    deleteMigrationJob(dst.client, dst.tenantId, job.destMigrationId),
  ]);
  await audit({
    side: "source",
    tenantId: src.tenantId,
    action: "delete",
    resource: "migration-sender",
    resourceId: job.sourceMigrationId,
    ok: true,
  });
  await audit({
    side: "dest",
    tenantId: dst.tenantId,
    action: "delete",
    resource: "migration-receiver",
    resourceId: job.destMigrationId,
    ok: true,
  });
  await updateJob(localJobId, { status: "cancelled" });
}

export async function purgeJob(localJobId: string): Promise<void> {
  await deleteJob(localJobId);
}

function aggregateStatus(
  src: { status?: string } | null,
  dst: { status?: string } | null,
  current: LocalMigrationJob["status"],
): LocalMigrationJob["status"] {
  if (current === "cancelled") return "cancelled";
  const s = (src?.status ?? "").toLowerCase();
  const d = (dst?.status ?? "").toLowerCase();

  const failedTokens = ["failed", "error"];
  const completeTokens = ["complete", "completed", "succeeded"];
  const partialTokens = ["partial", "partiallycomplete"];

  if (failedTokens.some((t) => s.includes(t)) || failedTokens.some((t) => d.includes(t))) {
    return "failed";
  }
  if (partialTokens.some((t) => s.includes(t)) || partialTokens.some((t) => d.includes(t))) {
    return "partially-complete";
  }
  if (completeTokens.some((t) => s.includes(t)) && completeTokens.some((t) => d.includes(t))) {
    return "complete";
  }
  return "in-progress";
}

interface SafeResult<T> {
  value: T | null;
  error?: string;
}
async function safe<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}
