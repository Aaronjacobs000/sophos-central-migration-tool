/**
 * Copies global exclusions and lists from source to destination: scanning
 * exclusions, allowed and blocked items, isolation and intrusion prevention
 * exclusions, custom exploit mitigation applications, Website Management
 * local sites, and websites excluded from TLS decryption. Items are matched
 * by value to avoid duplicates.
 */

import {
  listScanningExclusions,
  listAllowedItems,
  listBlockedItems,
  createScanningExclusion,
  createAllowedItem,
  createBlockedItem,
  listIsolationExclusions,
  listIntrusionPreventionExclusions,
  listCustomExploitMitigationApps,
  listTlsExcludedWebsites,
  createIsolationExclusion,
  createIntrusionPreventionExclusion,
  createExploitMitigationApp,
  addTlsExcludedWebsites,
  type SophosTlsExcludedWebsite,
} from "../sophos/api/exclusions.js";
import { listLocalSites, createLocalSite } from "../sophos/api/web-control.js";
import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";

export type ExclusionType =
  | "scanning"
  | "allowed-items"
  | "blocked-items"
  | "isolation"
  | "intrusion-prevention"
  | "exploit-mitigation"
  | "local-sites"
  | "tls-excluded-websites";

export const EXCLUSION_TYPES: ExclusionType[] = [
  "scanning",
  "allowed-items",
  "blocked-items",
  "isolation",
  "intrusion-prevention",
  "exploit-mitigation",
  "local-sites",
  "tls-excluded-websites",
];

/** Websites excluded from TLS decryption have no ID; their value identifies them. */
export const idOf = (type: ExclusionType, item: any): string =>
  type === "tls-excluded-websites" ? String(item.value ?? "") : String(item.id ?? "");

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

    const keyOf = (item: any) => keyFor(type, item);
    const destKeys = new Set(destItems.map(keyOf));
    const sourceById = new Map(sourceItems.map((it: any) => [idOf(type, it), it]));

    if (type === "tls-excluded-websites") {
      results.push(...(await copyTlsExcludedWebsites(ids, sourceById, destKeys, dst, req.dryRun === true)));
      continue;
    }

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

      if (destKeys.has(keyOf(item))) {
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
        const body = bodyFor(type, item);
        const created = await createForType(type, dst.client, dst.tenantId, body);
        destKeys.add(
          type === "scanning" || type === "allowed-items" || type === "blocked-items"
            ? itemKey({ ...item, id: created.id ?? "" })
            : keyOf(item),
        );
        await auditOrWarn({
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
        await auditOrWarn({
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

export function listForType(type: ExclusionType, client: any, tenantId: string): Promise<any[]> {
  if (type === "scanning") return listScanningExclusions(client, tenantId);
  if (type === "allowed-items") return listAllowedItems(client, tenantId);
  if (type === "blocked-items") return listBlockedItems(client, tenantId);
  if (type === "isolation") return listIsolationExclusions(client, tenantId);
  if (type === "intrusion-prevention") return listIntrusionPreventionExclusions(client, tenantId);
  if (type === "exploit-mitigation") return listCustomExploitMitigationApps(client, tenantId);
  if (type === "local-sites") return listLocalSites(client, tenantId);
  return listTlsExcludedWebsites(client, tenantId);
}

function createForType(
  type: ExclusionType,
  client: any,
  tenantId: string,
  body: Record<string, unknown>,
): Promise<{ id?: string }> {
  if (type === "scanning") return createScanningExclusion(client, tenantId, body);
  if (type === "allowed-items") return createAllowedItem(client, tenantId, body);
  if (type === "isolation") return createIsolationExclusion(client, tenantId, body as any);
  if (type === "intrusion-prevention") return createIntrusionPreventionExclusion(client, tenantId, body as any);
  if (type === "exploit-mitigation") return createExploitMitigationApp(client, tenantId, body as any);
  if (type === "local-sites") return createLocalSite(client, tenantId, body as any);
  return createBlockedItem(client, tenantId, body);
}

const sorted = (list: unknown): string =>
  Array.isArray(list) ? list.map((x) => String(x).toLowerCase()).sort().join(",") : "";

/**
 * Identity used for the duplicate check. The first three types keep the
 * original rule; the others compare the fields that define the exclusion.
 */
export function keyFor(type: ExclusionType, item: any): string {
  switch (type) {
    case "isolation":
    case "intrusion-prevention":
      return [
        String(item.direction ?? "").toLowerCase(),
        sorted(item.remoteAddresses),
        sorted(item.localPorts),
        sorted(item.remotePorts),
      ].join("|");
    case "exploit-mitigation":
      return sorted(item.paths);
    case "local-sites":
      return String(item.url ?? "").trim().toLowerCase();
    case "tls-excluded-websites":
      return String(item.value ?? "").trim().toLowerCase();
    default:
      return itemKey(item);
  }
}

/** The create body for a source item: only the fields the write API accepts. */
function bodyFor(type: ExclusionType, item: any): Record<string, unknown> {
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  switch (type) {
    case "isolation":
    case "intrusion-prevention": {
      const body: Record<string, unknown> = { direction: item.direction };
      if (nonEmpty(item.localPorts)) body.localPorts = item.localPorts;
      if (nonEmpty(item.remotePorts)) body.remotePorts = item.remotePorts;
      if (nonEmpty(item.remoteAddresses)) body.remoteAddresses = item.remoteAddresses;
      if (item.comment) body.comment = item.comment;
      return body;
    }
    case "exploit-mitigation":
      return { paths: item.paths ?? [] };
    case "local-sites": {
      const body: Record<string, unknown> = { url: item.url };
      if (typeof item.categoryId === "number") body.categoryId = item.categoryId;
      if (nonEmpty(item.tags)) body.tags = item.tags;
      if (item.comment) body.comment = item.comment;
      return body;
    }
    default:
      return stripIdentifiers(item);
  }
}

/** The TLS exclusion list is edited with PATCH { add }, up to 500 websites per call. */
async function copyTlsExcludedWebsites(
  ids: string[],
  sourceById: Map<string, any>,
  destKeys: Set<string>,
  dst: ReturnType<typeof requireContext>,
  dryRun: boolean,
): Promise<CopyExclusionResult[]> {
  const type: ExclusionType = "tls-excluded-websites";
  const results: CopyExclusionResult[] = [];
  const toAdd: SophosTlsExcludedWebsite[] = [];
  for (const id of ids) {
    const item = sourceById.get(id);
    if (!item) {
      results.push({ type, sourceId: id, ok: false, action: "create", error: "source item not found" });
    } else if (destKeys.has(keyFor(type, item))) {
      results.push({ type, sourceId: id, ok: true, action: "skip-exists" });
    } else if (dryRun) {
      results.push({ type, sourceId: id, ok: true, action: "dry-run-create" });
      destKeys.add(keyFor(type, item));
    } else {
      toAdd.push(item.comment ? { value: item.value, comment: item.comment } : { value: item.value });
      destKeys.add(keyFor(type, item));
    }
  }

  for (let i = 0; i < toAdd.length; i += TLS_BATCH) {
    const batch = toAdd.slice(i, i + TLS_BATCH);
    try {
      const res = await addTlsExcludedWebsites(dst.client, dst.tenantId, batch);
      const added = new Set((res.added ?? batch).map((w) => keyFor(type, w)));
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "update",
        resource: type,
        ok: true,
        detail: { add: batch, added: res.added ?? null },
      });
      for (const w of batch) {
        const ok = added.has(keyFor(type, w));
        results.push(ok
          ? { type, sourceId: w.value, destId: w.value, ok: true, action: "create" }
          : { type, sourceId: w.value, ok: false, action: "create", error: "the destination did not report this website as added" });
      }
    } catch (err) {
      const msg = errMsg(err);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "update",
        resource: type,
        ok: false,
        error: msg,
        detail: { add: batch },
      });
      for (const w of batch) {
        results.push({ type, sourceId: w.value, ok: false, action: "create", error: msg });
      }
    }
  }
  return results;
}

const TLS_BATCH = 500;

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
