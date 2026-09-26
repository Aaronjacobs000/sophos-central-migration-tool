/**
 * Job status and progress, worked out from each device.
 *
 * A device is requested until Sophos hands it over, then waits until it checks
 * in on the receiving tenant under its new ID (device-check-in.ts). Sophos
 * hands over in seconds; the check-in took 23 to 25 minutes in testing and can
 * take much longer for a laptop that is switched off, so a long wait is shown
 * as a wait, never as a failure. A device fails only when Sophos says so, or
 * when the migration job expires (14 days) before the device checked in.
 *
 * The job is requested until one device has arrived, in progress until all
 * have, then completed. When every device has either arrived or failed, it
 * ends completed with failures (some arrived) or failed (none did).
 */

import { checkInFor, mergeEndpointStatuses } from "./device-check-in.js";
import type { JobStatus, LocalMigrationJob } from "./migration-store.js";
import type { MigrationEndpointStatus } from "../sophos/api/migrations.js";

export type DeviceState = "requested" | "waiting" | "arrived" | "failed" | "expired";

export interface DeviceProgress {
  id: string;
  hostname: string;
  state: DeviceState;
  newId?: string;
  handedOverAt?: string;
  checkedInAt?: string;
  /** Why Sophos failed the device, when it said. */
  reason?: string;
  /** The device's group on the sending tenant when the job was created. */
  group?: string | null;
}

export interface JobProgress {
  status: JobStatus;
  total: number;
  arrived: number;
  waiting: number;
  requested: number;
  failed: number;
  expired: number;
  /** Share of devices that have arrived, 0 to 100. Only 100 when all have. */
  percent: number;
  /** No device is still requested or waiting, so nothing more will change. */
  finished: boolean;
  /** When the migration job expires: devices that have not checked in by then do not move. */
  expiresAt: string;
  /** Earliest handover among devices still waiting for check-in. */
  oldestWaitSince?: string;
  devices: DeviceProgress[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const JOB_LIFETIME_MS = 14 * DAY_MS;

type SnapshotWithDetails = { endpointDetails?: MigrationEndpointStatus[]; expiresAt?: string } | null | undefined;

function details(snap: unknown): MigrationEndpointStatus[] {
  return ((snap as SnapshotWithDetails)?.endpointDetails ?? []) as MigrationEndpointStatus[];
}

export function jobExpiresAt(job: Pick<LocalMigrationJob, "createdAt" | "sourceSnapshot" | "destSnapshot">): string {
  const fromApi = (job.sourceSnapshot as SnapshotWithDetails)?.expiresAt ?? (job.destSnapshot as SnapshotWithDetails)?.expiresAt;
  if (fromApi && Number.isFinite(Date.parse(fromApi))) return new Date(Date.parse(fromApi)).toISOString();
  return new Date(Date.parse(job.createdAt) + JOB_LIFETIME_MS).toISOString();
}

export function jobProgress(job: LocalMigrationJob, now: number = Date.now()): JobProgress {
  const receivingIsSource = job.direction === "dest-to-source";
  const moved = mergeEndpointStatuses(
    details(receivingIsSource ? job.sourceSnapshot : job.destSnapshot),
    details(receivingIsSource ? job.destSnapshot : job.sourceSnapshot),
  );
  const expiresAt = jobExpiresAt(job);
  const expired = now > Date.parse(expiresAt);

  const devices: DeviceProgress[] = job.endpointIds.map((id) => {
    const entry = moved.get(id);
    // Jobs never checked since check-in tracking began have no saved check-in; the snapshot still says whether Sophos handed the device over.
    const c = job.checkIns?.[id] ?? checkInFor(entry, []);
    const base = {
      id,
      hostname: job.endpointHostnames?.[id] || id,
      newId: c.newId,
      handedOverAt: c.handedOverAt,
      group: job.endpointGroups ? (job.endpointGroups[id]?.name ?? null) : undefined,
    };
    switch (c.state) {
      case "checked-in":
        return { ...base, state: "arrived", checkedInAt: c.checkedInAt };
      case "move-failed":
        return { ...base, state: "failed", reason: entry?.reason ?? (entry as { errorMessage?: string } | undefined)?.errorMessage };
      case "waiting":
        return { ...base, state: expired ? "expired" : "waiting" };
      default:
        return { ...base, state: expired ? "expired" : "requested" };
    }
  });

  const count = (s: DeviceState) => devices.filter((d) => d.state === s).length;
  const total = devices.length;
  const arrived = count("arrived");
  const waiting = count("waiting");
  const requested = count("requested");
  const failed = count("failed");
  const expiredCount = count("expired");
  const finished = total > 0 && waiting === 0 && requested === 0;

  let status: JobStatus;
  if (job.status === "cancelled") status = "cancelled";
  else if (finished) status = arrived === total ? "completed" : arrived > 0 ? "completed-with-failures" : "failed";
  else status = arrived > 0 ? "in-progress" : "requested";

  const waits = devices.filter((d) => d.state === "waiting" && d.handedOverAt).map((d) => d.handedOverAt!).sort();

  return {
    status,
    total,
    arrived,
    waiting,
    requested,
    failed,
    expired: expiredCount,
    percent: total === 0 ? 0 : arrived === total ? 100 : Math.floor((arrived / total) * 100),
    finished: finished || status === "cancelled",
    expiresAt,
    oldestWaitSince: waits[0],
    devices,
  };
}

/**
 * How long until the live stream checks a job again, or null once it has
 * finished. Quick while Sophos is handing devices over (seconds), slower while
 * they wait to check in (minutes), and slow when the credentials were refused,
 * so a deleted credential is not retried every few seconds for hours.
 */
export function nextCheckDelayMs(job: LocalMigrationJob, progress: JobProgress = jobProgress(job)): number | null {
  if (progress.finished) return null;
  const state = job.monitor?.state;
  if (state === "rejected" || state === "no-credentials" || state === "not-found") return 5 * 60_000;
  if (state === "error") return 60_000;
  if (progress.requested > 0) return 10_000;
  return 30_000;
}
