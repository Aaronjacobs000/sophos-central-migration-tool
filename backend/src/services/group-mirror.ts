/**
 * Mirrors endpoint groups and user groups from source to destination by name
 * + metadata.
 *
 * IMPORTANT: membership is NOT copied. Source endpoint IDs are meaningless
 * in the destination tenant. Devices reconstitute group membership after
 * migration based on destination policies.
 */

import { getGroup, listGroups, createGroup } from "../sophos/api/groups.js";
import { listUserGroups, createUserGroup } from "../sophos/api/user-groups.js";
import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";
import { createChecked } from "./write-check.js";
import type { SophosEndpointGroup } from "../sophos/types/migration.js";

export interface MirrorGroupsRequest {
  groupIds: string[];
  dryRun?: boolean;
}

export interface MirrorGroupResult {
  sourceId: string;
  sourceName: string;
  destId?: string;
  ok: boolean;
  action: "create" | "skip-exists" | "dry-run-create";
  error?: string;
  /** Notes for the results list, such as a create Sophos answered unclearly but a read-back found. */
  notes?: string[];
}

export async function mirrorGroups(req: MirrorGroupsRequest): Promise<MirrorGroupResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");

  const destExisting = await listGroups(dst.client, dst.tenantId);
  const destNames = new Set(destExisting.map((g) => g.name.toLowerCase()));
  const results: MirrorGroupResult[] = [];

  for (const sourceId of req.groupIds) {
    let sourceGroup: SophosEndpointGroup;
    try {
      sourceGroup = await getGroup(src.client, src.tenantId, sourceId);
    } catch (err) {
      results.push({
        sourceId,
        sourceName: "(unknown)",
        ok: false,
        action: "create",
        error: errMsg(err),
      });
      continue;
    }

    if (destNames.has(sourceGroup.name.toLowerCase())) {
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        ok: true,
        action: "skip-exists",
      });
      continue;
    }

    if (req.dryRun) {
      destNames.add(sourceGroup.name.toLowerCase());
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        ok: true,
        action: "dry-run-create",
      });
      continue;
    }

    try {
      // The create API rejects an empty description with 400 "Validation
      // failure" (measured 25/09/2026), and GET returns "" for groups made
      // without one, so only send a description that has text.
      const name = sourceGroup.name.toLowerCase();
      const { value: created, note } = await createChecked(
        () => createGroup(dst.client, dst.tenantId, {
          name: sourceGroup.name,
          ...(sourceGroup.description?.trim() ? { description: sourceGroup.description } : {}),
          type: sourceGroup.type,
          endpointType: sourceGroup.endpointType,
        }),
        async () => (await listGroups(dst.client, dst.tenantId)).find((g) => g.name.toLowerCase() === name),
        "the group",
      );
      // A second source group with this name ignoring case is then already there.
      destNames.add(name);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "endpoint-group",
        resourceId: created.id,
        ok: true,
        detail: { sourceId, name: sourceGroup.name, ...(note ? { note } : {}) },
      });
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        destId: created.id,
        ok: true,
        action: "create",
        ...(note ? { notes: [note] } : {}),
      });
    } catch (err) {
      const msg = errMsg(err);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "endpoint-group",
        ok: false,
        error: msg,
        detail: { sourceId, name: sourceGroup.name },
      });
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        ok: false,
        action: "create",
        error: msg,
      });
    }
  }

  return results;
}

export interface MirrorUserGroupsRequest {
  userGroupIds: string[];
  dryRun?: boolean;
}

/**
 * Mirrors user groups by name and description, skipping any whose name is
 * already on the destination, and audits each create, as for endpoint groups.
 */
export async function mirrorUserGroups(req: MirrorUserGroupsRequest): Promise<MirrorGroupResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");

  const [sourceGroups, destExisting] = await Promise.all([
    listUserGroups(src.client, src.tenantId),
    listUserGroups(dst.client, dst.tenantId),
  ]);
  const sourceById = new Map(sourceGroups.map((g) => [g.id, g]));
  const destNames = new Set(destExisting.map((g) => g.name.toLowerCase()));
  const results: MirrorGroupResult[] = [];

  for (const sourceId of req.userGroupIds) {
    const group = sourceById.get(sourceId);
    if (!group) {
      results.push({ sourceId, sourceName: "(unknown)", ok: false, action: "create", error: "source user group not found" });
      continue;
    }
    if (destNames.has(group.name.toLowerCase())) {
      results.push({ sourceId, sourceName: group.name, ok: true, action: "skip-exists" });
      continue;
    }
    if (req.dryRun) {
      destNames.add(group.name.toLowerCase());
      results.push({ sourceId, sourceName: group.name, ok: true, action: "dry-run-create" });
      continue;
    }
    const body = { name: group.name, ...(group.description?.trim() ? { description: group.description } : {}) };
    try {
      const name = group.name.toLowerCase();
      const { value: created, note } = await createChecked(
        () => createUserGroup(dst.client, dst.tenantId, body),
        async () => (await listUserGroups(dst.client, dst.tenantId)).find((g) => g.name.toLowerCase() === name),
        "the user group",
      );
      destNames.add(name);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "user-group",
        resourceId: created.id,
        ok: true,
        detail: { sourceId, name: group.name, ...(note ? { note } : {}) },
      });
      results.push({ sourceId, sourceName: group.name, destId: created.id, ok: true, action: "create", ...(note ? { notes: [note] } : {}) });
    } catch (err) {
      const msg = errMsg(err);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "user-group",
        ok: false,
        error: msg,
        detail: { sourceId, name: group.name },
      });
      results.push({ sourceId, sourceName: group.name, ok: false, action: "create", error: msg });
    }
  }

  return results;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
