/**
 * Mirrors endpoint groups from source to destination by name + metadata.
 *
 * IMPORTANT: membership is NOT copied. Source endpoint IDs are meaningless
 * in the destination tenant. Devices reconstitute group membership after
 * migration based on destination policies.
 */

import { getGroup, listGroups, createGroup } from "../sophos/api/groups.js";
import { requireContext } from "../state.js";
import { audit } from "./audit-log.js";
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
      const created = await createGroup(dst.client, dst.tenantId, {
        name: sourceGroup.name,
        ...(sourceGroup.description?.trim() ? { description: sourceGroup.description } : {}),
        type: sourceGroup.type,
        endpointType: sourceGroup.endpointType,
      });
      await audit({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "endpoint-group",
        resourceId: created.id,
        ok: true,
        detail: { sourceId, name: sourceGroup.name },
      });
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        destId: created.id,
        ok: true,
        action: "create",
      });
    } catch (err) {
      const msg = errMsg(err);
      await audit({
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
