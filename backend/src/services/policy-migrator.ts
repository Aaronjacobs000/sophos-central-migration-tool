/**
 * Reads policies from source and creates them on destination.
 * Supports dry-run mode that returns the plan without touching dest.
 *
 * Policy ASSIGNMENTS (`appliesTo`) are deliberately NOT migrated: the Central
 * public API rejects every `appliesTo` write (verified 02/07/2026 on live
 * tenants — create and PATCH, string and {id} ref shapes, computer and server
 * policies, against targets that definitely exist all fail with
 * 500 "Error processing data"; GET returns the block fine). Use the Policies
 * page "Export assignments (CSV)" to capture them for manual re-assignment.
 */

import { getPolicy, listPolicies, createPolicy, updatePolicy } from "../sophos/api/policies.js";
import { listLocalSites } from "../sophos/api/web-control.js";
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
      settings: sanitizeSettings(sourcePolicy.settings),
    };

    // Notes about anything we had to change to make the policy writable on
    // the destination — surfaced in the result so nothing is silently lost.
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
              `dropped website tag rule "${rule?.tag}" — that tag doesn't exist in the destination tenant (create its Website Management entries first, then re-migrate)`,
            );
          }
        }
      } catch {
        // Tag lookup is best-effort; if it fails we attempt the write as-is.
      }
    }

    if (req.dryRun) {
      results.push({
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: true,
        action: match ? "dry-run-overwrite" : "dry-run-create",
        adjustments: adjustments.length ? adjustments : undefined,
      });
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
            adjustments.push(`dropped setting ${settingKey} — destination rejected it (${msg})`);
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
      results.push({
        sourceId,
        sourceName: sourcePolicy.name,
        destId: result.id,
        destName: result.name,
        ok: true,
        action: match ? "overwrite" : "create",
        adjustments: adjustments.length ? adjustments : undefined,
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
        detail: {
          sourceId,
          name: sourcePolicy.name,
          type: sourcePolicy.type,
          ...(adjustments.length ? { adjustments } : {}),
        },
      });
      results.push({
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: false,
        action: match ? "overwrite" : "create",
        error: msg,
        adjustments: adjustments.length ? adjustments : undefined,
      });
    }
  }

  return results;
}

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
