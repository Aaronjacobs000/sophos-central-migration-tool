/**
 * Copies scanning exclusions / allowed items / blocked items from source
 * to destination. Items are matched by structural value to avoid duplicates.
 */

import {
  listScanningExclusions,
  listAllowedItems,
  listBlockedItems,
  createScanningExclusion,
  createAllowedItem,
  createBlockedItem,
} from "../sophos/api/exclusions.js";
import { requireContext } from "../state.js";
import { audit } from "./audit-log.js";

export type ExclusionType = "scanning" | "allowed-items" | "blocked-items";

export interface CopyExclusionsRequest {
  /** Map of exclusion type → list of source IDs to copy. */
  selections: Partial<Record<ExclusionType, string[]>>;
  dryRun?: boolean;
}

export interface CopyExclusionResult {
  type: ExclusionType;
  sourceId: string;
  destId?: string;
  ok: boolean;
  action: "create" | "skip-exists" | "dry-run-create";
  error?: string;
}

export async function copyExclusions(
  req: CopyExclusionsRequest,
): Promise<CopyExclusionResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");
  const results: CopyExclusionResult[] = [];

  const types = Object.keys(req.selections) as ExclusionType[];

  for (const type of types) {
    const ids = req.selections[type] ?? [];
    if (ids.length === 0) continue;

    // Fetch source items + dest items once per type
    const [sourceItems, destItems] = await Promise.all([
      listForType(type, src.client, src.tenantId),
      listForType(type, dst.client, dst.tenantId),
    ]);

    const destKeys = new Set(destItems.map(itemKey));
    const sourceById = new Map(sourceItems.map((it) => [it.id, it]));

    for (const id of ids) {
      const item = sourceById.get(id);
      if (!item) {
        results.push({
          type,
          sourceId: id,
          ok: false,
          action: "create",
          error: "source item not found",
        });
        continue;
      }

      if (destKeys.has(itemKey(item))) {
        results.push({
          type,
          sourceId: id,
          ok: true,
          action: "skip-exists",
        });
        continue;
      }

      if (req.dryRun) {
        results.push({
          type,
          sourceId: id,
          ok: true,
          action: "dry-run-create",
        });
        continue;
      }

      try {
        const body = stripIdentifiers(item);
        const created = await createForType(type, dst.client, dst.tenantId, body);
        destKeys.add(itemKey({ ...item, id: created.id ?? "" }));
        await audit({
          side: "dest",
          tenantId: dst.tenantId,
          action: "create",
          resource: type,
          resourceId: created.id,
          ok: true,
          detail: { sourceId: id, body },
        });
        results.push({
          type,
          sourceId: id,
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
          resource: type,
          ok: false,
          error: msg,
          detail: { sourceId: id },
        });
        results.push({
          type,
          sourceId: id,
          ok: false,
          action: "create",
          error: msg,
        });
      }
    }
  }

  return results;
}

function listForType(type: ExclusionType, client: any, tenantId: string) {
  if (type === "scanning") return listScanningExclusions(client, tenantId);
  if (type === "allowed-items") return listAllowedItems(client, tenantId);
  return listBlockedItems(client, tenantId);
}

function createForType(
  type: ExclusionType,
  client: any,
  tenantId: string,
  body: Record<string, unknown>,
): Promise<{ id?: string }> {
  if (type === "scanning") return createScanningExclusion(client, tenantId, body);
  if (type === "allowed-items") return createAllowedItem(client, tenantId, body);
  return createBlockedItem(client, tenantId, body);
}

function itemKey(item: any): string {
  if (item.value !== undefined) return `${item.type}::${item.value}`;
  if (item.properties !== undefined)
    return `${item.type}::${stableStringify(item.properties)}`;
  return `${item.type}::${item.id}`;
}

function stripIdentifiers(item: any): Record<string, unknown> {
  const { id, createdAt, ...rest } = item;
  return rest;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
