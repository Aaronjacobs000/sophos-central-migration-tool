/**
 * Deletes web filtering site lists and profiles on the destination: the
 * undo for a copy.
 *
 * Profiles go first. The API refuses (409) to delete a site list a profile
 * still uses, or a profile a policy still uses, so deleting a profile and
 * its lists in one request works, and anything still in use is reported
 * and left alone, in a dry run and a real run alike. Every delete is
 * audited.
 */

import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";
import {
  listSiteLists,
  listProfiles,
  deleteSiteList,
  deleteProfile,
} from "../sophos/api/web-filters.js";
import { listPolicies } from "../sophos/api/policies.js";

export interface DeleteWebFiltersRequest {
  siteListIds?: string[];
  profileIds?: string[];
  dryRun?: boolean;
}

export interface WebFilterDeleteResult {
  kind: "site-list" | "profile";
  id: string;
  name: string;
  ok: boolean;
  action: "delete" | "dry-run-delete";
  error?: string;
}

const RESOURCE = { "site-list": "web-filter-site-list", profile: "web-filter-profile" } as const;

export async function deleteWebFilters(req: DeleteWebFiltersRequest): Promise<WebFilterDeleteResult[]> {
  const dst = requireContext("dest");
  const dryRun = req.dryRun === true;
  const action = dryRun ? "dry-run-delete" : "delete";
  const siteListIds = [...new Set(req.siteListIds ?? [])];
  const profileIds = [...new Set(req.profileIds ?? [])];
  const results: WebFilterDeleteResult[] = [];

  const [lists, profiles] = await Promise.all([
    siteListIds.length ? listSiteLists(dst.client, dst.tenantId) : Promise.resolve([]),
    profileIds.length ? listProfiles(dst.client, dst.tenantId) : Promise.resolve([]),
  ]);
  const listById = new Map(lists.map((l) => [l.id, l]));
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  // Policy names for the "in use" message, read only when a profile is in use.
  let policyNames: Map<string, string> | undefined;
  const policyName = async (id: string) => {
    if (!policyNames) {
      try {
        policyNames = new Map((await listPolicies(dst.client, dst.tenantId)).map((p) => [p.id, p.name]));
      } catch {
        policyNames = new Map();
      }
    }
    return policyNames.get(id) ?? id;
  };

  const remove = async (kind: WebFilterDeleteResult["kind"], id: string, name: string) => {
    if (dryRun) {
      results.push({ kind, id, name, ok: true, action });
      return true;
    }
    try {
      await (kind === "profile" ? deleteProfile : deleteSiteList)(dst.client, dst.tenantId, id);
      await auditOrWarn({ side: "dest", tenantId: dst.tenantId, action: "delete", resource: RESOURCE[kind], resourceId: id, ok: true, detail: { name } });
      results.push({ kind, id, name, ok: true, action });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await auditOrWarn({ side: "dest", tenantId: dst.tenantId, action: "delete", resource: RESOURCE[kind], resourceId: id, ok: false, error: msg, detail: { name } });
      results.push({ kind, id, name, ok: false, action, error: msg });
      return false;
    }
  };

  // Profiles deleted (or, in a dry run, planned) in this run no longer hold their lists.
  const goneProfiles = new Set<string>();
  for (const id of profileIds) {
    const profile = profileById.get(id);
    if (!profile) {
      results.push({ kind: "profile", id, name: "(unknown)", ok: false, action, error: "not on the destination" });
      continue;
    }
    const users = profile.consumers ?? [];
    if (users.length) {
      const names = await Promise.all(users.map((u) => policyName(u.id)));
      results.push({
        kind: "profile", id, name: profile.name, ok: false, action,
        error: `in use by ${users.length === 1 ? "policy" : "policies"} ${names.map((n) => `"${n}"`).join(", ")}; delete ${users.length === 1 ? "it" : "them"} or pick another profile there first`,
      });
      continue;
    }
    if (await remove("profile", id, profile.name)) goneProfiles.add(id);
  }

  for (const id of siteListIds) {
    const list = listById.get(id);
    if (!list) {
      results.push({ kind: "site-list", id, name: "(unknown)", ok: false, action, error: "not on the destination" });
      continue;
    }
    const users = (list.usedBy ?? []).filter((u) => !goneProfiles.has(u.id));
    if (users.length) {
      results.push({
        kind: "site-list", id, name: list.name, ok: false, action,
        error: `in use by ${users.length === 1 ? "profile" : "profiles"} ${users.map((u) => `"${u.name ?? u.id}"`).join(", ")}; delete ${users.length === 1 ? "it" : "them"} or remove the list from ${users.length === 1 ? "it" : "them"} first`,
      });
      continue;
    }
    await remove("site-list", id, list.name);
  }

  return results;
}
