/**
 * Two-tenant device migration orchestration.
 *
 * Workflow (matches Sophos docs):
 *   1. Preflight: read each selected source endpoint, reject any that
 *      haven't checked in within the last 14 days.
 *   2. POST receiver job on DESTINATION → returns job id + handshake token.
 *   3. PUT sender trigger on SOURCE using the SAME job id + token.
 *      (This is NOT a second POST; it triggers the existing job.)
 *   4. Persist the job ID to data/migration-jobs.json, with the group each
 *      device was in on the sending tenant (read in step 1), so the job page
 *      can put moved devices back into same-named groups afterwards.
 *   5. UI subscribes via SSE to /api/migrate/devices/jobs/:id/stream.
 */

import { requireContext } from "../state.js";
import {
  getEndpoint,
} from "../sophos/api/endpoints.js";
import {
  createReceiverJob,
  triggerSenderJob,
  deleteMigrationJob,
  getMigrationJob,
  listMigrationJobEndpoints,
} from "../sophos/api/migrations.js";
import {
  createJob,
  deleteJob,
  getJob,
  updateJob,
  type EndpointGroupRef,
  type LocalMigrationJob,
} from "./migration-store.js";
import { audit } from "./audit-log.js";
import { checkMigrationWindow } from "./migration-window.js";
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
  /**
   * Set when either tenant has Device Migration turned off or expired. Both
   * tenants must allow it, and a receiving tenant accepts a receiver job
   * whatever the sending tenant's setting (measured 25/09/2026), leaving a
   * job the API cannot delete, so nothing is created.
   */
  settingFailure?: string;
  /** Present in dry-run mode: the plan we would execute. */
  plan?: {
    sourceTenantId: string;
    sourceApiHost: string;
    destTenantId: string;
    destApiHost: string;
    receiverBody: { fromTenant: string; endpoints: string[] };
    senderTrigger: { method: string; endpoints: string[]; token: string };
    /** Groups the devices are in on the sending tenant, recorded with the job. */
    groups: Array<{ name: string; count: number }>;
    /** Devices in no group. */
    ungrouped: number;
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

  // Step 0: both tenants must allow device migration (Sophos help, "Device
  // migration", Sep 2026). A setting that cannot be read does not block.
  const window = await checkMigrationWindow(direction);
  const closed = [window.sending, window.receiving].filter((c) => c.status === "off" || c.status === "closed");
  if (closed.length > 0) {
    const names = closed.map((c) => `${c.tenantName || c.side} (the ${c.role} tenant): ${c.message}`);
    return {
      preflightFailures: [],
      settingFailure: `Device migration is not allowed. ${names.join(" ")} Both tenants must allow it: in Sophos Fusion, go to Global Settings > Device Migration and turn on Allow device migration.`,
    };
  }

  // Step 1: preflight, load each endpoint from the "from" side
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
  const endpointGroups = groupSnapshot(acceptedEndpoints);

  if (req.dryRun) {
    return {
      preflightFailures: [],
      plan: {
        sourceTenantId: from.tenantId,
        sourceApiHost: from.summary.apiHost,
        destTenantId: to.tenantId,
        destApiHost: to.summary.apiHost,
        receiverBody: {
          fromTenant: from.tenantId,
          endpoints: endpointIds,
        },
        senderTrigger: {
          method: "PUT /endpoint/v1/migrations/{receiverJobId}",
          endpoints: endpointIds,
          token: "<would be returned by receiver job>",
        },
        ...summariseGroups(endpointGroups),
      },
    };
  }

  // Step 2: POST receiver job on the destination tenant.
  // fromTenant = the sending tenant (where endpoints currently live).
  const receiverBody = {
    fromTenant: from.tenantId,
    endpoints: endpointIds,
  };
  log.emit("info", "migration", `Creating receiver job on ${to.label} (${to.tenantId})`, {
    side: to.label as "source" | "dest",
    detail: { body: receiverBody },
  });
  const receiver = await createReceiverJob(to.client, to.tenantId, receiverBody);
  log.emit("info", "migration", `Receiver job created: id=${receiver.id}, mode=${(receiver as any).mode}`, {
    side: to.label as "source" | "dest",
    detail: { response: receiver },
  });
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

  // Step 3: PUT sender trigger on the source tenant.
  // Uses the SAME job ID from the receiver. Body is just { token, endpoints }.
  const senderBody = {
    token: handshakeToken,
    endpoints: endpointIds,
  };
  log.emit("info", "migration", `Triggering sender on ${from.label} (${from.tenantId}), jobId=${receiver.id}`, {
    side: from.label as "source" | "dest",
    detail: { jobId: receiver.id, endpointCount: endpointIds.length },
  });
  let sender;
  try {
    sender = await triggerSenderJob(from.client, from.tenantId, receiver.id, senderBody);
    log.emit("info", "migration", `Sender triggered: id=${sender.id}, mode=${(sender as any).mode}`, {
      side: from.label as "source" | "dest",
      detail: { response: sender },
    });
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

  // Step 4: persist locally.
  // The migration job ID is shared across both tenants (same ID).
  const job = await createJob({
    jobName: req.jobName,
    sourceMigrationId: sender.id,
    destMigrationId: receiver.id,
    fromToken: handshakeToken,
    endpointIds: acceptedEndpoints.map((e) => e.id),
    endpointHostnames: Object.fromEntries(
      acceptedEndpoints.map((e) => [e.id, e.hostname ?? ""]),
    ),
    endpointGroups,
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

  // Decide aggregate status from job-level AND endpoint-level data.
  const allEndpoints = [
    ...(srcEndpoints.value ?? []),
    ...(dstEndpoints.value ?? []),
  ];
  const status = aggregateStatus(
    srcJob.value,
    dstJob.value,
    allEndpoints,
    job.endpointIds.length,
    job.status,
  );

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

/**
 * Determine the aggregate migration status from job-level and endpoint-level
 * data. The Sophos API doesn't always populate a top-level job status, so
 * endpoint-level statuses are the most reliable signal.
 */
function aggregateStatus(
  src: { status?: string } | null,
  dst: { status?: string } | null,
  endpoints: Array<{ status?: string }>,
  expectedCount: number,
  current: LocalMigrationJob["status"],
): LocalMigrationJob["status"] {
  if (current === "cancelled") return "cancelled";

  const isMatch = (value: string, tokens: string[]) =>
    tokens.some((t) => value.includes(t));

  const failedTokens = ["failed", "error"];
  const completeTokens = ["complete", "completed", "succeeded", "migrated"];

  // 1. Check job-level status first (some API versions do populate it)
  const s = (src?.status ?? "").toLowerCase();
  const d = (dst?.status ?? "").toLowerCase();

  if (isMatch(s, failedTokens) || isMatch(d, failedTokens)) {
    return "failed";
  }
  if (isMatch(s, completeTokens) && isMatch(d, completeTokens)) {
    return "complete";
  }

  // 2. Fall back to endpoint-level statuses (the reliable signal).
  //    Deduplicate by looking at both source and dest endpoint lists.
  //    Each endpoint appears in both, so count distinct statuses.
  const epStatuses = endpoints.map((e) => (e.status ?? "").toLowerCase());
  const succeeded = epStatuses.filter((s) => isMatch(s, completeTokens)).length;
  const failed = epStatuses.filter((s) => isMatch(s, failedTokens)).length;
  const pending = epStatuses.filter((s) => s === "pending" || s === "").length;

  // Both sender and receiver report per-endpoint status, so a single
  // endpoint shows up twice (once on each side). Use the endpoint count
  // from the local job as ground truth.
  // If every endpoint succeeded on at least one side, the migration worked.
  if (succeeded > 0 && failed === 0 && pending === 0) {
    return "complete";
  }
  if (failed > 0 && pending === 0) {
    return succeeded > 0 ? "partially-complete" : "failed";
  }

  return "in-progress";
}

/**
 * The group each device is in, from the endpoint records the preflight
 * already read. Membership has to be captured before the move: once a device
 * leaves, the sending tenant no longer lists it.
 */
function groupSnapshot(endpoints: SophosEndpoint[]): Record<string, EndpointGroupRef | null> {
  const out: Record<string, EndpointGroupRef | null> = {};
  for (const ep of endpoints) {
    const group = (ep as SophosEndpoint & { group?: { id?: string; name?: string } }).group;
    out[ep.id] = group?.name ? { id: group.id, name: group.name } : null;
  }
  return out;
}

function summariseGroups(snapshot: Record<string, EndpointGroupRef | null>) {
  const counts = new Map<string, number>();
  let ungrouped = 0;
  for (const g of Object.values(snapshot)) {
    if (g?.name) counts.set(g.name, (counts.get(g.name) ?? 0) + 1);
    else ungrouped++;
  }
  const groups = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { groups, ungrouped };
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
