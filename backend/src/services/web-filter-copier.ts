/**
 * Copies web filtering site lists and profiles from source to destination.
 *
 * Order matters: site lists first, then profiles, because a profile's
 * siteListActions refer to site lists by ID. Each list ID is mapped to the
 * destination list with the same name, including lists created earlier in
 * the same run. A rule whose list has no destination counterpart is dropped
 * and reported. Profile consumers (the policies using a profile) are not
 * copied; cloning a web control policy maps its web profile ID instead.
 *
 * Names are matched without regard to case. Supports dry run, and every
 * write is audited.
 */

import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";
import {
  listSiteLists,
  listSites,
  createSiteList,
  listProfiles,
  getProfile,
  createProfile,
  type SophosSiteList,
  type SophosWebProfile,
} from "../sophos/api/web-filters.js";

export interface CopyWebFiltersRequest {
  siteListIds?: string[];
  profileIds?: string[];
  dryRun?: boolean;
}

export interface WebFilterCopyResult {
  kind: "site-list" | "profile";
  sourceId: string;
  sourceName: string;
  destId?: string;
  ok: boolean;
  action: "create" | "skip-exists" | "dry-run-create";
  error?: string;
  /** Rules changed or dropped to fit the destination. */
  adjustments?: string[];
  /** Extra detail for the results list, such as the number of sites. */
  note?: string;
}

const nameKey = (name: string | undefined) => String(name ?? "").trim().toLowerCase();

export async function copyWebFilters(req: CopyWebFiltersRequest): Promise<WebFilterCopyResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");
  const siteListIds = req.siteListIds ?? [];
  const profileIds = req.profileIds ?? [];
  const dryRun = req.dryRun === true;
  const results: WebFilterCopyResult[] = [];

  const [srcLists, dstLists] = await Promise.all([
    listSiteLists(src.client, src.tenantId),
    listSiteLists(dst.client, dst.tenantId),
  ]);
  const srcListById = new Map(srcLists.map((l) => [l.id, l]));
  const dstListByName = new Map(dstLists.map((l) => [nameKey(l.name), l]));
  // Source list ID -> destination list ID, or "planned" for a list a dry run would create.
  const listMap = new Map<string, string>();
  for (const l of srcLists) {
    const match = dstListByName.get(nameKey(l.name));
    if (match) listMap.set(l.id, match.id);
  }

  // ---- site lists ----
  for (const id of siteListIds) {
    const list = srcListById.get(id);
    if (!list) {
      results.push({ kind: "site-list", sourceId: id, sourceName: "(unknown)", ok: false, action: "create", error: "source site list not found" });
      continue;
    }
    const existing = dstListByName.get(nameKey(list.name));
    if (existing) {
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, destId: existing.id, ok: true, action: "skip-exists" });
      continue;
    }
    let sites: string[];
    try {
      sites = (await listSites(src.client, src.tenantId, id)).map((s) => s.site).filter(Boolean);
    } catch (err) {
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: `could not read the source sites: ${errMsg(err)}` });
      continue;
    }
    if (sites.length === 0) {
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: "the list has no sites, and the API needs at least one" });
      continue;
    }
    const body = { name: list.name, sites, ...(list.description ? { description: list.description } : {}) };
    if (dryRun) {
      listMap.set(id, "planned");
      dstListByName.set(nameKey(list.name), { id: "planned", name: list.name });
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: true, action: "dry-run-create", note: `${sites.length} site${sites.length === 1 ? "" : "s"}` });
      continue;
    }
    try {
      const created = await createSiteList(dst.client, dst.tenantId, body);
      listMap.set(id, created.id);
      dstListByName.set(nameKey(list.name), created);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-site-list",
        resourceId: created.id,
        ok: true,
        detail: { sourceId: id, name: list.name, siteCount: sites.length },
      });
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, destId: created.id, ok: true, action: "create", note: `${sites.length} site${sites.length === 1 ? "" : "s"}` });
    } catch (err) {
      const msg = errMsg(err);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-site-list",
        ok: false,
        error: msg,
        detail: { sourceId: id, name: list.name, siteCount: sites.length },
      });
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: msg });
    }
  }

  if (profileIds.length === 0) return results;

  // ---- profiles ----
  const [srcProfiles, dstProfiles] = await Promise.all([
    listProfiles(src.client, src.tenantId),
    listProfiles(dst.client, dst.tenantId),
  ]);
  const srcProfileById = new Map(srcProfiles.map((p) => [p.id, p]));
  const dstProfileByName = new Map(dstProfiles.map((p) => [nameKey(p.name), p]));

  for (const id of profileIds) {
    const summary = srcProfileById.get(id);
    if (!summary) {
      results.push({ kind: "profile", sourceId: id, sourceName: "(unknown)", ok: false, action: "create", error: "source profile not found" });
      continue;
    }
    const existing = dstProfileByName.get(nameKey(summary.name));
    if (existing) {
      results.push({ kind: "profile", sourceId: id, sourceName: summary.name, destId: existing.id, ok: true, action: "skip-exists" });
      continue;
    }
    let profile: SophosWebProfile;
    try {
      profile = await getProfile(src.client, src.tenantId, id);
    } catch (err) {
      results.push({ kind: "profile", sourceId: id, sourceName: summary.name, ok: false, action: "create", error: `could not read the source profile: ${errMsg(err)}` });
      continue;
    }
    const { body, adjustments } = profileBody(profile, srcListById, listMap);
    if (dryRun) {
      dstProfileByName.set(nameKey(profile.name), { id: "planned", name: profile.name });
      results.push({ kind: "profile", sourceId: id, sourceName: profile.name, ok: true, action: "dry-run-create", ...(adjustments.length ? { adjustments } : {}) });
      continue;
    }
    try {
      const created = await createProfile(dst.client, dst.tenantId, body);
      dstProfileByName.set(nameKey(profile.name), created);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-profile",
        resourceId: created.id,
        ok: true,
        detail: { sourceId: id, name: profile.name, ...(adjustments.length ? { adjustments } : {}) },
      });
      results.push({ kind: "profile", sourceId: id, sourceName: profile.name, destId: created.id, ok: true, action: "create", ...(adjustments.length ? { adjustments } : {}) });
    } catch (err) {
      const msg = errMsg(err);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-profile",
        ok: false,
        error: msg,
        detail: { sourceId: id, name: profile.name, ...(adjustments.length ? { adjustments } : {}) },
      });
      results.push({ kind: "profile", sourceId: id, sourceName: profile.name, ok: false, action: "create", error: msg, ...(adjustments.length ? { adjustments } : {}) });
    }
  }

  return results;
}

/**
 * The create body for a profile on the destination: every filtering field,
 * site list IDs mapped to the destination, consumers left out.
 */
export function profileBody(
  profile: SophosWebProfile,
  srcListById: Map<string, SophosSiteList>,
  listMap: Map<string, string>,
): { body: Omit<SophosWebProfile, "id" | "updatedAt" | "consumers">; adjustments: string[] } {
  const adjustments: string[] = [];
  const body: Omit<SophosWebProfile, "id" | "updatedAt" | "consumers"> = { name: profile.name };
  if (profile.description) body.description = profile.description;
  if (profile.filterByCategory !== undefined) body.filterByCategory = profile.filterByCategory;
  if (profile.preset) body.preset = profile.preset;
  if (profile.categoryGroupActions?.length) body.categoryGroupActions = profile.categoryGroupActions;
  if (profile.categoryActions?.length) body.categoryActions = profile.categoryActions;
  if (profile.filterBySiteList !== undefined) body.filterBySiteList = profile.filterBySiteList;

  if (profile.siteListActions?.length) {
    const mapped: NonNullable<SophosWebProfile["siteListActions"]> = [];
    for (const rule of profile.siteListActions) {
      const listName = srcListById.get(rule.id)?.name ?? rule.id;
      const destId = listMap.get(rule.id);
      if (!destId) {
        adjustments.push(`dropped the "${rule.action}" rule for site list "${listName}": that list is not on the destination (copy the site list first)`);
        continue;
      }
      if (destId === "planned") {
        adjustments.push(`site list "${listName}" would map to the copy made in this run`);
        mapped.push({ ...rule });
        continue;
      }
      mapped.push({ ...rule, id: destId });
    }
    if (mapped.length) body.siteListActions = mapped;
  }
  if (profile.consumers?.length) {
    adjustments.push(`${profile.consumers.length} linked polic${profile.consumers.length === 1 ? "y is" : "ies are"} not copied; cloning a web control policy links it to this profile by name`);
  }
  return { body, adjustments };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
