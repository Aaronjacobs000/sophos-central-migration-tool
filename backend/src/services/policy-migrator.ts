/**
 * Reads policies from source and creates them on destination.
 * Supports dry-run mode that returns the plan without touching dest.
 *
 * Policy ASSIGNMENTS (`appliesTo`) are deliberately NOT migrated: the Central
 * public API rejects every `appliesTo` write (verified 02/07/2026 on live
 * tenants: create and PATCH, string and {id} ref shapes, computer and server
 * policies, against targets that definitely exist all fail with
 * 500 "Error processing data"; GET returns the block fine). Use the Policies
 * page "Export assignments (CSV)" to capture them for manual re-assignment.
 *
 * A clone goes to the bottom of the destination's priority order, just
 * above the base policy, whatever its priority on the source; an overwrite
 * leaves the destination policy where it is.
 *
 * Web control policies name their web filtering profile by ID. The source
 * tenant's IDs mean nothing on the destination, so the ID is mapped to the
 * destination profile with the same name, or the setting is dropped and
 * reported when there is none.
 */

import { getPolicy, listPolicies, createPolicy, updatePolicy } from "../sophos/api/policies.js";
import { listLocalSites } from "../sophos/api/web-control.js";
import { listProfiles } from "../sophos/api/web-filters.js";
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
  /**
   * Human-readable notes about settings that had to be changed or dropped to
   * fit the destination tenant (e.g. website tag rules whose tag doesn't
   * exist there, or settings the destination API refused to accept).
   */
  adjustments?: string[];
}

export async function migratePolicies(
  req: MigratePoliciesRequest,
): Promise<MigratePolicyResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");

  // Cache the destination's existing policies once so we can match by name+type.
  const destExisting = await listPolicies(dst.client, dst.tenantId);

  // Website tags available in the destination (from its local-site list),
  // fetched at most once per run. Web-control policies reference these tags by
  // name and the API rejects policies naming tags the tenant doesn't have.
  let destTagsPromise: Promise<Set<string>> | undefined;
  const destWebsiteTags = () =>
    (destTagsPromise ??= (async () => {
      const tags = new Set<string>();
      for (const site of await listLocalSites(dst.client, dst.tenantId)) {
        for (const t of site.tags ?? []) tags.add(t);
      }
      return tags;
    })());

  // Web filtering profiles on both sides, looked up at most once per run and
  // only when a policy refers to one.
  let profileMapPromise: Promise<WebProfileMap> | undefined;
  const webProfiles = () =>
    (profileMapPromise ??= (async () => {
      const [s, d] = await Promise.all([
        listProfiles(src.client, src.tenantId),
        listProfiles(dst.client, dst.tenantId),
      ]);
      return {
        sourceNameById: new Map(s.map((p) => [p.id, p.name])),
        destIdByName: new Map(d.map((p) => [p.name.trim().toLowerCase(), p.id])),
      };
    })());

  // Read every source policy first so a batch can be written from the top
  // of the source order down: each create asks for the bottom, so a later
  // create lands beneath an earlier one and the batch keeps its source order.
  // Results still come back in request order.
  const fetched: Array<SophosPolicy | Error> = [];
  for (const sourceId of req.policyIds) {
    try {
      fetched.push(await getPolicy(src.client, src.tenantId, sourceId));
    } catch (err) {
      fetched.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  const priorityOf = (p: SophosPolicy | Error) => (p instanceof Error ? 0 : p.priority ?? 0);
  const order = req.policyIds.map((_, i) => i).sort((a, b) => priorityOf(fetched[b]!) - priorityOf(fetched[a]!));

  const results: MigratePolicyResult[] = new Array(req.policyIds.length);

  for (const i of order) {
    const sourceId = req.policyIds[i]!;
    const got = fetched[i]!;
    if (got instanceof Error) {
      results[i] = {
        sourceId,
        sourceName: "(unknown)",
        ok: false,
        action: "create",
        error: got.message,
      };
      continue;
    }
    const sourcePolicy = got;

    const match = destExisting.find(
      (p) => p.name === sourcePolicy.name && p.type === sourcePolicy.type,
    );

    if (match && !req.overwrite) {
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match.id,
        destName: match.name,
        ok: true,
        action: "skip-exists",
      };
      continue;
    }

    const body: Partial<SophosPolicy> = {
      name: sourcePolicy.name,
      type: sourcePolicy.type,
      enabled: sourcePolicy.enabled,
      ...(match ? {} : { priority: BOTTOM_PRIORITY }),
      enforced: sourcePolicy.enforced,
      settings: sanitizeSettings(sourcePolicy.settings),
    };

    // Notes about anything we had to change to make the policy writable on
    // the destination, surfaced in the result so nothing is silently lost.
    const adjustments: string[] = [];

    // Web-control policies reference Website Management tags by name inside
    // endpoint.web-control.tags.settings. A tag the destination doesn't have
    // makes the whole create fail (an opaque 500), so keep only the rules
    // whose tag exists there and report every dropped rule.
    const tagsSetting = body.settings?.[WEB_TAGS_SETTING] as
      | { value?: Array<{ tag?: string; action?: string }> }
      | undefined;
    if (Array.isArray(tagsSetting?.value) && tagsSetting.value.length) {
      try {
        const available = await destWebsiteTags();
        const dropped = tagsSetting.value.filter((rule) => !available.has(rule?.tag ?? ""));
        if (dropped.length) {
          tagsSetting.value = tagsSetting.value.filter((rule) => available.has(rule?.tag ?? ""));
          for (const rule of dropped) {
            adjustments.push(
              `dropped website tag rule "${rule?.tag}": that tag doesn't exist in the destination tenant (create its Website Management entries first, then re-migrate)`,
            );
          }
        }
      } catch {
        // Tag lookup is best-effort; if it fails we attempt the write as-is.
      }
    }

    await remapWebProfiles(body.settings, webProfiles, adjustments);

    if (req.dryRun) {
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: true,
        action: match ? "dry-run-overwrite" : "dry-run-create",
        adjustments: adjustments.length ? adjustments : undefined,
      };
      continue;
    }

    try {
      let result: SophosPolicy;
      // The write API rejects some settings the GET happily returns. When the
      // error names the offending setting ("… for setting (X)"), drop just
      // that setting and retry so one bad setting doesn't sink the policy.
      // Every drop is recorded in `adjustments`.
      for (let attempt = 0; ; attempt++) {
        try {
          result = match
            ? await updatePolicy(dst.client, dst.tenantId, match.id, body)
            : await createPolicy(dst.client, dst.tenantId, body);
          break;
        } catch (err) {
          const msg = errMsg(err);
          const settingKey = /for setting \(([^)]+)\)/.exec(msg)?.[1];
          if (
            attempt < MAX_SETTING_RETRIES &&
            settingKey &&
            body.settings &&
            settingKey in body.settings
          ) {
            delete body.settings[settingKey];
            adjustments.push(`dropped setting ${settingKey}: destination rejected it (${msg})`);
            continue;
          }
          throw err;
        }
      }
      await audit({
        side: "dest",
        tenantId: dst.tenantId,
        action: match ? "update" : "create",
        resource: "policy",
        resourceId: match?.id ?? result.id,
        ok: true,
        detail: {
          sourceId,
          name: sourcePolicy.name,
          type: sourcePolicy.type,
          ...(adjustments.length ? { adjustments } : {}),
        },
      });
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: result.id,
        destName: result.name,
        ok: true,
        action: match ? "overwrite" : "create",
        adjustments: adjustments.length ? adjustments : undefined,
      };
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
        detail: {
          sourceId,
          name: sourcePolicy.name,
          type: sourcePolicy.type,
          ...(adjustments.length ? { adjustments } : {}),
        },
      });
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: false,
        action: match ? "overwrite" : "create",
        error: msg,
        adjustments: adjustments.length ? adjustments : undefined,
      };
    }
  }

  return results;
}

export interface WebProfileMap {
  sourceNameById: Map<string, string>;
  destIdByName: Map<string, string>;
}

const WEB_PROFILE_ID_SUFFIX = ".web-profile-id";
const WEB_PROFILE_SCHEDULES_SUFFIX = ".web-profile-schedules";

/**
 * Point a policy's web profile at the destination. The profile ID setting
 * (endpoint.web-control.web-profile-id) is mapped by profile name. Any source
 * profile ID inside the schedules setting is mapped the same way. A profile
 * with no destination counterpart drops the setting, and every change is
 * added to adjustments.
 */
export async function remapWebProfiles(
  settings: Record<string, unknown> | undefined,
  loadMap: () => Promise<WebProfileMap>,
  adjustments: string[],
): Promise<void> {
  if (!settings) return;
  const idKeys = Object.keys(settings).filter((k) => {
    const v = (settings[k] as { value?: unknown } | undefined)?.value;
    return k.endsWith(WEB_PROFILE_ID_SUFFIX) && typeof v === "string" && v.length > 0;
  });
  const scheduleKeys = Object.keys(settings).filter((k) => {
    if (!k.endsWith(WEB_PROFILE_SCHEDULES_SUFFIX)) return false;
    const v = (settings[k] as { value?: unknown } | undefined)?.value;
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "";
  });
  if (idKeys.length === 0 && scheduleKeys.length === 0) return;

  let map: WebProfileMap;
  try {
    map = await loadMap();
  } catch (err) {
    adjustments.push(`could not look up web filtering profiles, so the web profile ID was sent unchanged (${errMsg(err)})`);
    return;
  }
  const destIdFor = (sourceId: string) => {
    const name = map.sourceNameById.get(sourceId);
    return { name, destId: name ? map.destIdByName.get(name.trim().toLowerCase()) : undefined };
  };

  for (const key of idKeys) {
    const setting = settings[key] as { value: string };
    const { name, destId } = destIdFor(setting.value);
    if (destId) {
      settings[key] = { ...setting, value: destId };
      adjustments.push(`mapped web profile "${name}" to the destination profile with the same name`);
    } else {
      delete settings[key];
      adjustments.push(
        name
          ? `dropped the web profile setting: profile "${name}" is not on the destination (copy it on the Web filtering page first, then clone again)`
          : `dropped the web profile setting: profile ${setting.value} was not found on the source`,
      );
    }
  }

  for (const key of scheduleKeys) {
    const missing: string[] = [];
    let changed = false;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string" && map.sourceNameById.has(v)) {
        const { name, destId } = destIdFor(v);
        if (destId) {
          changed = changed || destId !== v;
          return destId;
        }
        missing.push(name ?? v);
        return v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, inner]) => [k, walk(inner)]));
      }
      return v;
    };
    const next = walk(settings[key]);
    if (missing.length) {
      delete settings[key];
      adjustments.push(`dropped the web profile schedule: ${missing.map((n) => `"${n}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} not on the destination`);
    } else if (changed) {
      settings[key] = next;
      adjustments.push("mapped the profiles in the web profile schedule to the destination");
    }
  }
}

/**
 * Priorities count up from the base policy (0), and a larger number wins:
 * a policy created without one gets the next number up, which the API docs
 * call the highest priority. Asking for 1 puts the new policy at the bottom,
 * just above the base policy, and the API moves the existing policies of
 * that type up by one, keeping their order. Both measured on a live tenant
 * on 24/09/2026; deleting the clone moves them back down.
 */
const BOTTOM_PRIORITY = 1;

/** Setting key holding a web-control policy's Website Management tag rules. */
const WEB_TAGS_SETTING = "endpoint.web-control.tags.settings";

/** Max drop-and-retry attempts when the destination rejects named settings. */
const MAX_SETTING_RETRIES = 5;

/**
 * The policy GET shape is not write-safe verbatim: settings may carry a
 * read-only `unit` field that create/update rejects ("Must not provide a
 * unit for setting …"). Strip it, keeping everything else intact.
 */
function sanitizeSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!settings) return settings;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(settings)) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const { unit: _unit, ...rest } = raw as Record<string, unknown>;
      out[key] = rest;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
