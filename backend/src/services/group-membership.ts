/**
 * Group membership after a device move.
 *
 * A moved device arrives on the receiving tenant with a new ID. The API docs
 * do not say whether it keeps a group, so this puts it into the destination
 * group with the same name as the group it was in on the sending tenant:
 *   1. GET /endpoint/v1/migrations/{id}/endpoints gives each device's newId.
 *   2. The job's group snapshot (taken when the job was created) gives the
 *      source group. Jobs created before the snapshot existed fall back to
 *      reading the device on the sending tenant, which only works while the
 *      old record is still there.
 *   3. POST /endpoint/v1/endpoint-groups/{id}/endpoints on the receiving
 *      tenant adds the new IDs, skipping devices already in the group.
 *
 * The caller can pick the destination group per device instead (choices),
 * which is how a device goes back into a group the sending tenant doesn't
 * have, or in no group there: a round trip through a tenant without that
 * group loses the name. A choice of null leaves the device out.
 *
 * Group assignments carry policy with them, so a policy assigned to a group
 * follows the device. Groups synced from Active Directory refuse API writes
 * (HTTP 409); that is reported per group. Supports dry run, and every write
 * is audited. The job's own tenants and stored credentials are used
 * (job-access.ts), so this never writes to whatever pair the tool points at now.
 */

import { auditOrWarn } from "./audit-log.js";
import { isUnclearWrite, readBack, foundNote, notFound } from "./write-check.js";
import { verifiedContextsForJob } from "./job-access.js";
import { getJob, type EndpointGroupRef } from "./migration-store.js";
import { listMigrationEndpointStatuses, type MigrationEndpointStatus } from "../sophos/api/migrations.js";
import { listAllGroups, listGroupEndpointIds, addEndpointsToGroup, type AddToGroupResponse } from "../sophos/api/groups.js";
import { getEndpoint } from "../sophos/api/endpoints.js";
import type { TenantLabel } from "../sophos/tenant-context.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";

export type MembershipStatus =
  | "will-add"
  | "added"
  | "already-member"
  | "no-group"
  | "group-missing"
  | "not-moved"
  | "move-failed"
  | "no-new-id"
  | "left-out"
  | "error";

export interface MembershipRow {
  endpointId: string;
  hostname: string;
  newId: string | null;
  sourceGroup: string | null;
  destGroupId: string | null;
  status: MembershipStatus;
  message?: string;
}

export interface MembershipGroupResult {
  name: string;
  destGroupId: string;
  ids: string[];
  ok: boolean | null;
  error?: string;
}

export interface MembershipResult {
  localJobId: string;
  dryRun: boolean;
  receivingSide: TenantLabel;
  rows: MembershipRow[];
  groups: MembershipGroupResult[];
  counts: Record<MembershipStatus, number>;
  /** The receiving tenant's groups, by name, for picking a destination group. */
  destGroups: Array<{ id: string; name: string; type?: string }>;
}

/** Destination group per device (by its ID on the sending tenant): a group ID, or null to leave it out. */
export type MembershipChoices = Record<string, string | null>;

export class JobNotFoundError extends Error {}

const ADD_BATCH = 1000;
const nameKey = (n: string | undefined) => String(n ?? "").trim().toLowerCase();

export async function restoreGroupMembership(
  localJobId: string,
  opts: { dryRun?: boolean; choices?: MembershipChoices } = {},
): Promise<MembershipResult> {
  const dryRun = opts.dryRun === true;
  const choices = opts.choices ?? {};
  const job = await getJob(localJobId);
  if (!job) throw new JobNotFoundError(`migration job ${localJobId} not found`);

  const sendingSide: TenantLabel = job.direction === "dest-to-source" ? "dest" : "source";
  const receivingSide: TenantLabel = sendingSide === "source" ? "dest" : "source";
  // The job's own tenants, whatever the tool points at now.
  const contexts = await verifiedContextsForJob(job);
  const from = contexts[sendingSide];
  const to = contexts[receivingSide];

  // 1. New IDs. The receiving side is asked first; the sending side fills gaps.
  const statusById = new Map<string, MigrationEndpointStatus>();
  const receiverJobId = receivingSide === "dest" ? job.destMigrationId : job.sourceMigrationId;
  const senderJobId = sendingSide === "source" ? job.sourceMigrationId : job.destMigrationId;
  for (const e of await listMigrationEndpointStatuses(to.client, to.tenantId, receiverJobId)) {
    statusById.set(e.id, e);
  }
  if (job.endpointIds.some((id) => !statusById.get(id)?.newId)) {
    try {
      for (const e of await listMigrationEndpointStatuses(from.client, from.tenantId, senderJobId)) {
        const known = statusById.get(e.id);
        if (!known || (!known.newId && e.newId)) statusById.set(e.id, { ...known, ...e, status: known?.status ?? e.status });
      }
    } catch {
      // The receiving side's answer stands on its own.
    }
  }

  // 2. Source groups: the snapshot, or a read of the old record for older jobs.
  const sourceGroupOf = new Map<string, EndpointGroupRef | null>();
  for (const id of job.endpointIds) {
    if (job.endpointGroups && id in job.endpointGroups) {
      sourceGroupOf.set(id, job.endpointGroups[id] ?? null);
      continue;
    }
    try {
      const ep = (await getEndpoint(from.client, from.tenantId, id)) as SophosEndpoint & { group?: { id?: string; name?: string } };
      sourceGroupOf.set(id, ep.group?.name ? { id: ep.group.id, name: ep.group.name } : null);
    } catch {
      // No snapshot and the old record is gone: the group is unknown.
    }
  }

  // 3. Destination groups and their current members.
  const destGroups = await listAllGroups(to.client, to.tenantId);
  const destGroupByName = new Map(destGroups.map((g) => [nameKey(g.name), g]));
  const destGroupById = new Map(destGroups.map((g) => [g.id, g]));
  const membersCache = new Map<string, Set<string>>();
  const membersOf = async (groupId: string) => {
    if (!membersCache.has(groupId)) {
      membersCache.set(groupId, new Set(await listGroupEndpointIds(to.client, to.tenantId, groupId)));
    }
    return membersCache.get(groupId)!;
  };

  const rows: MembershipRow[] = [];
  for (const id of job.endpointIds) {
    const hostname = job.endpointHostnames?.[id] || id;
    const st = statusById.get(id);
    const status = String(st?.status ?? "").toLowerCase();
    const group = sourceGroupOf.has(id) ? sourceGroupOf.get(id)! : undefined;
    const base = { endpointId: id, hostname, newId: st?.newId ?? null, sourceGroup: group?.name ?? null, destGroupId: null };

    if (status.includes("fail") || status.includes("error")) {
      rows.push({ ...base, status: "move-failed", message: st?.reason || "the move failed" });
      continue;
    }
    if (!["succeeded", "complete", "completed", "migrated"].some((t) => status.includes(t))) {
      rows.push({ ...base, status: "not-moved", message: status ? `still ${status}` : "no status yet" });
      continue;
    }
    if (!st?.newId) {
      rows.push({ ...base, status: "no-new-id", message: "the job did not return the device's new ID" });
      continue;
    }
    // A group picked for this device, or the one with its source group's name.
    const choice = Object.prototype.hasOwnProperty.call(choices, id) ? choices[id] : undefined;
    if (choice === null) {
      rows.push({ ...base, status: "left-out", message: "not added to a group" });
      continue;
    }
    let dest: (typeof destGroups)[number] | undefined;
    if (choice) {
      dest = destGroupById.get(choice);
      if (!dest) {
        rows.push({ ...base, status: "group-missing", message: "the group picked is no longer on the destination; pick another" });
        continue;
      }
    } else {
      if (group === undefined) {
        rows.push({ ...base, status: "no-group", message: "no group was recorded; pick one to add it" });
        continue;
      }
      if (group === null) {
        rows.push({ ...base, status: "no-group", message: "in no group on the sending tenant; pick one to add it" });
        continue;
      }
      dest = destGroupByName.get(nameKey(group.name));
      if (!dest) {
        rows.push({ ...base, status: "group-missing", message: `no group named "${group.name}" here; pick one, or mirror it on the Groups page` });
        continue;
      }
    }
    const members = await membersOf(dest.id);
    if (members.has(st.newId)) {
      rows.push({ ...base, destGroupId: dest.id, status: "already-member" });
      continue;
    }
    rows.push({ ...base, destGroupId: dest.id, status: "will-add" });
  }

  // Group the additions per destination group.
  const plan = new Map<string, MembershipGroupResult>();
  for (const r of rows) {
    if (r.status !== "will-add" || !r.destGroupId || !r.newId) continue;
    const entry = plan.get(r.destGroupId) ?? { name: destGroupById.get(r.destGroupId)?.name ?? "", destGroupId: r.destGroupId, ids: [], ok: null };
    entry.ids.push(r.newId);
    plan.set(r.destGroupId, entry);
  }
  const groups = [...plan.values()];

  if (!dryRun) {
    for (const g of groups) {
      const addedIds = new Set<string>();
      const problems = new Map<string, string>();
      // Devices a read-back found in the group after an unclear answer, with the note that says so.
      const readBackNotes = new Map<string, string>();
      let failure: string | undefined;
      for (let i = 0; i < g.ids.length; i += ADD_BATCH) {
        const batch = g.ids.slice(i, i + ADD_BATCH);
        try {
          let res: AddToGroupResponse;
          let note: string | undefined;
          try {
            res = await addEndpointsToGroup(to.client, to.tenantId, g.destGroupId, batch);
          } catch (err) {
            if (!isUnclearWrite(err)) throw err;
            // Sophos gave no clear answer: read the group back and count who is in it.
            const inGroup = async () => {
              const members = new Set(await listGroupEndpointIds(to.client, to.tenantId, g.destGroupId));
              return batch.filter((id) => members.has(id));
            };
            let found = await readBack(async () => {
              const got = await inGroup();
              return got.length === batch.length ? got : undefined;
            });
            if (!found) found = await inGroup().catch(() => []);
            if (!found.length) throw notFound(err);
            note = foundNote(err, found.length === 1 ? "the device in the group" : "the devices in the group");
            const unclear = notFound(err).message;
            for (const id of batch) if (!found.includes(id)) problems.set(id, unclear);
            for (const id of found) readBackNotes.set(id, note);
            res = { addedEndpoints: found.map((id) => ({ id })) };
          }
          for (const e of res.addedEndpoints ?? []) addedIds.add(e.id);
          for (const id of res.errors?.endpointsNotFound ?? []) problems.set(id, "the destination did not find this device");
          for (const id of res.errors?.endpointsOfWrongType ?? []) problems.set(id, "the device type does not match the group type");
          // Without an addedEndpoints list, treat every ID without an error as added.
          if (!res.addedEndpoints) for (const id of batch) if (!problems.has(id)) addedIds.add(id);
          await auditOrWarn({
            side: receivingSide,
            tenantId: to.tenantId,
            action: "update",
            resource: "endpoint-group-membership",
            resourceId: g.destGroupId,
            ok: problems.size === 0,
            detail: { localJobId, group: g.name, ids: batch, added: [...addedIds], errors: res.errors ?? null, ...(note ? { note } : {}) },
            ...(problems.size ? { error: `${problems.size} device(s) not added` } : {}),
          });
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          for (const id of batch) problems.set(id, /\b409\b/.test(failure) ? "the group is synced from Active Directory, so the API cannot add to it" : failure);
          await auditOrWarn({
            side: receivingSide,
            tenantId: to.tenantId,
            action: "update",
            resource: "endpoint-group-membership",
            resourceId: g.destGroupId,
            ok: false,
            error: failure,
            detail: { localJobId, group: g.name, ids: batch },
          });
        }
      }
      g.ok = problems.size === 0;
      if (failure) g.error = failure;
      for (const r of rows) {
        if (r.destGroupId !== g.destGroupId || r.status !== "will-add" || !r.newId) continue;
        if (addedIds.has(r.newId)) {
          r.status = "added";
          const note = readBackNotes.get(r.newId);
          if (note) r.message = note;
        } else {
          r.status = "error";
          r.message = problems.get(r.newId) ?? "the destination did not confirm the addition";
        }
      }
    }
  }

  const counts = Object.fromEntries(
    (["will-add", "added", "already-member", "no-group", "group-missing", "not-moved", "move-failed", "no-new-id", "left-out", "error"] as MembershipStatus[])
      .map((s) => [s, rows.filter((r) => r.status === s).length]),
  ) as Record<MembershipStatus, number>;

  const pickable = destGroups
    .map((g) => ({ id: g.id, name: g.name, ...(g.type ? { type: g.type } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { localJobId, dryRun, receivingSide, rows, groups, counts, destGroups: pickable };
}
