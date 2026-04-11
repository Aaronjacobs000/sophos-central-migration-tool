/**
 * Reads policies from source and creates them on destination.
 * Supports dry-run mode that returns the plan without touching dest.
 */

import { getPolicy, listPolicies, createPolicy, updatePolicy } from "../sophos/api/policies.js";
import { requireContext } from "../state.js";
import { audit } from "./audit-log.js";
import type { SophosPolicy } from "../sophos/types/migration.js";

export interface MigratePoliciesRequest {
  policyIds: string[];
  /** If true, overwrite existing destination policies with the same name+type. */
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface MigratePolicyResult {
  sourceId: string;
  sourceName: string;
  destId?: string;
  destName?: string;
  ok: boolean;
  action: "create" | "overwrite" | "skip-exists" | "dry-run-create" | "dry-run-overwrite";
  error?: string;
}

export async function migratePolicies(
  req: MigratePoliciesRequest,
): Promise<MigratePolicyResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");

  // Cache the destination's existing policies once so we can match by name+type.
  const destExisting = await listPolicies(dst.client, dst.tenantId);

  const results: MigratePolicyResult[] = [];

  for (const sourceId of req.policyIds) {
    let sourcePolicy: SophosPolicy;
    try {
      sourcePolicy = await getPolicy(src.client, src.tenantId, sourceId);
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

    const match = destExisting.find(
      (p) => p.name === sourcePolicy.name && p.type === sourcePolicy.type,
    );

    if (match && !req.overwrite) {
      results.push({
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match.id,
        destName: match.name,
        ok: true,
        action: "skip-exists",
      });
      continue;
    }

    const body: Partial<SophosPolicy> = {
      name: sourcePolicy.name,
      type: sourcePolicy.type,
      enabled: sourcePolicy.enabled,
      priority: sourcePolicy.priority,
      enforced: sourcePolicy.enforced,
      settings: sourcePolicy.settings,
    };

    if (req.dryRun) {
      results.push({
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: true,
        action: match ? "dry-run-overwrite" : "dry-run-create",
      });
      continue;
    }

    try {
      let result: SophosPolicy;
      if (match) {
        result = await updatePolicy(dst.client, dst.tenantId, match.id, body);
        await audit({
          side: "dest",
          tenantId: dst.tenantId,
          action: "update",
          resource: "policy",
          resourceId: match.id,
          ok: true,
          detail: { sourceId, name: sourcePolicy.name, type: sourcePolicy.type },
        });
      } else {
        result = await createPolicy(dst.client, dst.tenantId, body);
        await audit({
          side: "dest",
          tenantId: dst.tenantId,
          action: "create",
          resource: "policy",
          resourceId: result.id,
          ok: true,
          detail: { sourceId, name: sourcePolicy.name, type: sourcePolicy.type },
        });
      }
      results.push({
        sourceId,
        sourceName: sourcePolicy.name,
        destId: result.id,
        destName: result.name,
        ok: true,
        action: match ? "overwrite" : "create",
      });
    } catch (err) {
      const msg = errMsg(err);
      await audit({
        side: "dest",
        tenantId: dst.tenantId,
        action: match ? "update" : "create",
        resource: "policy",
        resourceId: match?.id,
        ok: false,
        error: msg,
        detail: { sourceId, name: sourcePolicy.name, type: sourcePolicy.type },
      });
      results.push({
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: false,
        action: match ? "overwrite" : "create",
        error: msg,
      });
    }
  }

  return results;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
