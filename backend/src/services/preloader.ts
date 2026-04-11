/**
 * Server-side preload cache. After the user successfully saves credentials
 * (or on demand via the API) this service kicks off background fetches for
 * every section we want the UI to render instantly: policies, groups,
 * scanning exclusions, allowed items, blocked items, and endpoints — for
 * both source and destination.
 *
 * Per-section status is tracked separately so the dashboard can show
 * which sections loaded, which are still in progress, and which failed.
 * The cached data is served back via /api/preload/data/:section/:side.
 */

import { requireContext } from "../state.js";
import type { TenantLabel } from "../sophos/tenant-context.js";
import { listPolicies } from "../sophos/api/policies.js";
import { listGroups } from "../sophos/api/groups.js";
import {
  listScanningExclusions,
  listAllowedItems,
  listBlockedItems,
} from "../sophos/api/exclusions.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { log } from "../log.js";

export type SectionId =
  | "policies"
  | "groups"
  | "scanning-exclusions"
  | "allowed-items"
  | "blocked-items"
  | "endpoints";

export const SECTIONS: SectionId[] = [
  "policies",
  "groups",
  "scanning-exclusions",
  "allowed-items",
  "blocked-items",
  "endpoints",
];

export type SectionState = "idle" | "loading" | "ok" | "error";

export interface SectionStatus {
  state: SectionState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  itemCount?: number;
  error?: string;
}

interface CacheSlot {
  status: SectionStatus;
  data: unknown[];
}

type SideCache = Record<SectionId, CacheSlot>;
const empty = (): SideCache => {
  const out = {} as SideCache;
  for (const s of SECTIONS) {
    out[s] = { status: { state: "idle" }, data: [] };
  }
  return out;
};

const cache: Record<TenantLabel, SideCache> = {
  source: empty(),
  dest: empty(),
};

export function getSectionStatus(
  side: TenantLabel,
  section: SectionId,
): SectionStatus {
  return cache[side][section].status;
}

export function getSectionData(
  side: TenantLabel,
  section: SectionId,
): { status: SectionStatus; items: unknown[] } {
  const slot = cache[side][section];
  return { status: slot.status, items: slot.data };
}

export function getPreloadStatus(): {
  source: Record<SectionId, SectionStatus>;
  dest: Record<SectionId, SectionStatus>;
} {
  const out = {
    source: {} as Record<SectionId, SectionStatus>,
    dest: {} as Record<SectionId, SectionStatus>,
  };
  for (const s of SECTIONS) {
    out.source[s] = cache.source[s].status;
    out.dest[s] = cache.dest[s].status;
  }
  return out;
}

export function resetPreloadCache(): void {
  cache.source = empty();
  cache.dest = empty();
}

/**
 * Run one section fetch and update its slot. Errors are captured into the
 * status so the UI can show them; they never throw out of this function.
 */
async function fetchSection(side: TenantLabel, section: SectionId): Promise<void> {
  const slot = cache[side][section];
  const startedAt = new Date();
  slot.status = { state: "loading", startedAt: startedAt.toISOString() };
  log.emit("info", "preload", `start ${section}`, { side });

  try {
    const ctx = requireContext(side);
    let items: unknown[] = [];
    switch (section) {
      case "policies":
        items = await listPolicies(ctx.client, ctx.tenantId);
        break;
      case "groups":
        items = await listGroups(ctx.client, ctx.tenantId);
        break;
      case "scanning-exclusions":
        items = await listScanningExclusions(ctx.client, ctx.tenantId);
        break;
      case "allowed-items":
        items = await listAllowedItems(ctx.client, ctx.tenantId);
        break;
      case "blocked-items":
        items = await listBlockedItems(ctx.client, ctx.tenantId);
        break;
      case "endpoints":
        items = await listAllEndpoints(ctx.client, ctx.tenantId);
        break;
    }
    const finishedAt = new Date();
    slot.data = items;
    slot.status = {
      state: "ok",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      itemCount: items.length,
    };
    log.emit(
      "info",
      "preload",
      `ok ${section} (${items.length} items in ${slot.status.durationMs}ms)`,
      { side, detail: { itemCount: items.length, durationMs: slot.status.durationMs } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    slot.status = {
      state: "error",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: message,
    };
    log.emit("error", "preload", `error ${section}: ${message}`, {
      side,
      detail: { error: message },
    });
  }
}

/**
 * Kick off preload fetches for both sides. Each section runs concurrently
 * (12 in flight: 6 sections × 2 sides). Returns immediately — callers can
 * inspect status via getPreloadStatus().
 */
export function startPreload(): void {
  resetPreloadCache();
  log.emit("info", "preload", "starting full preload (both sides)");
  const tasks: Promise<void>[] = [];
  for (const side of ["source", "dest"] as TenantLabel[]) {
    for (const section of SECTIONS) {
      tasks.push(fetchSection(side, section));
    }
  }
  Promise.all(tasks).then(() => {
    log.emit("info", "preload", "preload complete");
  });
}

/**
 * Refresh a single section/side combination on demand (e.g. user clicked
 * a refresh button on the dashboard).
 */
export async function refreshSection(
  side: TenantLabel,
  section: SectionId,
): Promise<SectionStatus> {
  await fetchSection(side, section);
  return cache[side][section].status;
}
