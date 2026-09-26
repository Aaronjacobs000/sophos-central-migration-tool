/**
 * Per-device check-in on the receiving tenant after a move.
 *
 * The migrations API reports a device "succeeded" within seconds, with the ID
 * it has on the receiving tenant (newId). Sophos registers a record under that
 * ID at once, offline, with lastSeenAt equal to registeredAt. The device itself
 * only arrives when it next checks in, which took 23 to 25 minutes on both moves
 * measured on 26/09/2026; lastSeenAt then moves past registeredAt.
 *
 * Records are matched by newId only, never by hostname: the receiving tenant
 * can hold older offline records with the same hostname (a device that moved
 * away and back leaves one behind).
 */

import type { TenantContext } from "../sophos/tenant-context.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import type { MigrationEndpointStatus } from "../sophos/api/migrations.js";
import type { DeviceCheckIn, LocalMigrationJob } from "./migration-store.js";

/** A receiving-tenant endpoint record, as far as check-in needs it. */
export interface ReceivedRecord {
  id: string;
  hostname?: string;
  lastSeenAt?: string;
  registeredAt?: string;
}

/**
 * How far lastSeenAt must pass the registration to count as a check-in.
 * Registration sets the two equal; the margin absorbs clock noise, and a real
 * check-in comes many minutes later.
 */
export const CHECK_IN_MARGIN_MS = 60_000;

/** IDs per endpoint list call. */
const ID_BATCH = 100;

const SUCCEEDED = new Set(["complete", "completed", "succeeded", "migrated"]);
const FAILED = new Set(["failed", "error"]);

/**
 * One device's check-in state. `moved` is its entry in the migration job,
 * `records` are receiving-tenant endpoint records (only the one whose ID is the
 * device's newId is used), `previous` is the state saved by the last poll.
 */
export function checkInFor(
  moved: MigrationEndpointStatus | undefined,
  records: ReceivedRecord[],
  previous?: DeviceCheckIn,
): DeviceCheckIn {
  if (previous?.state === "checked-in") return previous;
  // Without the job's answer (the call failed, or Sophos no longer returns an
  // expired job), a device already handed over is still looked up by its new ID.
  if (!moved && previous?.state === "waiting" && previous.newId) {
    moved = { id: "", status: "succeeded", newId: previous.newId, migratedAt: previous.handedOverAt };
  }
  if (!moved) return previous ?? { state: "not-moved" };
  const status = (moved.status ?? "").toLowerCase();
  if (FAILED.has(status)) return { state: "move-failed" };
  if (!SUCCEEDED.has(status)) return { state: "not-moved" };

  const newId = moved.newId ?? previous?.newId;
  const handedOverAt = moved.migratedAt ?? previous?.handedOverAt;
  const waiting: DeviceCheckIn = { state: "waiting", newId, handedOverAt };
  const record = newId ? records.find((r) => r.id === newId) : undefined;
  if (!record?.lastSeenAt) return waiting;
  const registered = Date.parse(record.registeredAt ?? handedOverAt ?? "");
  const seen = Date.parse(record.lastSeenAt);
  if (!Number.isFinite(registered) || !Number.isFinite(seen) || seen - registered <= CHECK_IN_MARGIN_MS) {
    return waiting;
  }
  return { state: "checked-in", newId, handedOverAt, checkedInAt: record.lastSeenAt };
}

/**
 * Check-in state for every device in a job. The receiving side's job entries
 * carry newId; the sending side's fill any device the receiving side did not
 * return. Only devices handed over and not yet checked in are looked up, by ID.
 */
/**
 * One entry per device from both sides of a job. The receiving side's entries
 * carry newId; the sending side's fill any device the receiving side did not
 * return.
 */
export function mergeEndpointStatuses(
  receiving: MigrationEndpointStatus[] | null | undefined,
  sending: MigrationEndpointStatus[] | null | undefined,
): Map<string, MigrationEndpointStatus> {
  const byId = new Map<string, MigrationEndpointStatus>();
  for (const e of receiving ?? []) byId.set(e.id, e);
  for (const e of sending ?? []) {
    const known = byId.get(e.id);
    byId.set(e.id, known ? { ...e, ...known, newId: known.newId ?? e.newId, migratedAt: known.migratedAt ?? e.migratedAt } : e);
  }
  return byId;
}

export async function refreshCheckIns(
  job: LocalMigrationJob,
  receiving: MigrationEndpointStatus[] | null,
  sending: MigrationEndpointStatus[] | null,
  to: TenantContext,
): Promise<{ checkIns: Record<string, DeviceCheckIn>; error?: string }> {
  const byId = mergeEndpointStatuses(receiving, sending);

  const previous = job.checkIns ?? {};
  const wanted = new Set<string>();
  for (const id of job.endpointIds) {
    const draft = checkInFor(byId.get(id), [], previous[id]);
    if (draft.state === "waiting" && draft.newId) wanted.add(draft.newId);
  }

  const records: ReceivedRecord[] = [];
  let error: string | undefined;
  const ids = [...wanted];
  try {
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      records.push(...(await listAllEndpoints(to.client, to.tenantId, { ids: ids.slice(i, i + ID_BATCH) })));
    }
  } catch (err) {
    error = `Check-in lookup on the receiving tenant failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const checkIns: Record<string, DeviceCheckIn> = {};
  for (const id of job.endpointIds) checkIns[id] = checkInFor(byId.get(id), records, previous[id]);
  return { checkIns, error };
}

/** True while a handed-over device has not checked in on the receiving tenant. */
export function awaitingCheckIn(job: Pick<LocalMigrationJob, "checkIns">): boolean {
  return Object.values(job.checkIns ?? {}).some((c) => c.state === "waiting");
}
