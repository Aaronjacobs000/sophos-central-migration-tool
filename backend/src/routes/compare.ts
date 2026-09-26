/**
 * Server-side compare endpoints. These compose reads from both tenant
 * contexts and return diff payloads — they never write to either side.
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import { requireContext } from "../state.js";
import { listPolicies, getPolicy } from "../sophos/api/policies.js";
import { listGroups } from "../sophos/api/groups.js";
import {
  listScanningExclusions,
  listAllowedItems,
  listBlockedItems,
} from "../sophos/api/exclusions.js";
import { listProfiles } from "../sophos/api/web-filters.js";
import { diff, summarize } from "../compare/json-diff.js";
import { pairPolicy } from "../compare/policy-pairing.js";
import { log } from "../log.js";
import {
  WEB_PROFILE_ID_SUFFIX,
  WEB_PROFILE_SCHEDULES_SUFFIX,
} from "../services/policy-migrator.js";
import type { SophosPolicy } from "../sophos/types/migration.js";
import type { TenantContext, TenantLabel } from "../sophos/tenant-context.js";

export const compareRouter = Router();

// --- Deep policy match cache (used by /api/compare/policies/deep) ---

export type PolicyMatchStatus = "match" | "differ" | "source-only" | "dest-only";

interface DeepPolicyMatch {
  type: string;
  name: string;
  sourceId: string | null;
  destId: string | null;
  status: PolicyMatchStatus;
  /** Number of leaf-level changes; -1 if the deep fetch failed. */
  diffCount: number;
}

interface DeepPolicyMatchResult {
  computedAt: string;
  durationMs: number;
  matches: DeepPolicyMatch[];
  byType: Record<string, DeepPolicyMatch[]>;
}

let deepMatchCache: {
  key: string;
  inFlight: Promise<DeepPolicyMatchResult> | null;
  result: DeepPolicyMatchResult | null;
} | null = null;

/**
 * Drop the deep-match cache. Called from state.rebuildContexts() after a
 * credentials change so we don't serve a stale comparison from a previous
 * tenant pair.
 */
export function clearDeepMatchCache(): void {
  deepMatchCache = null;
}

const DEEP_MATCH_CONCURRENCY = 5;

compareRouter.use("/compare", requireConfigured);

/**
 * GET /api/compare/policies — list-level diff: which policies exist on source
 * only, dest only, or both, paired by pairPolicy().
 */
compareRouter.get("/compare/policies", async (_req, res, next) => {
  try {
    const src = requireContext("source");
    const dst = requireContext("dest");
    const [s, d] = await Promise.all([
      listPolicies(src.client, src.tenantId),
      listPolicies(dst.client, dst.tenantId),
    ]);

    const sourceOnly: SophosPolicy[] = [];
    const both: Array<{ source: SophosPolicy; dest: SophosPolicy }> = [];
    const pairedDestIds = new Set<string>();

    for (const sp of s) {
      const dp = pairPolicy(sp, s, d).dest;
      if (dp) {
        both.push({ source: sp, dest: dp });
        pairedDestIds.add(dp.id);
      } else sourceOnly.push(sp);
    }
    const destOnly = d.filter((dp) => !pairedDestIds.has(dp.id));

    res.json({ sourceOnly, destOnly, both });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/compare/policies/:sourceId/:destId? — deep diff between two
 * policies' settings. If destId is omitted, the destination policy is the one
 * pairPolicy() pairs the source policy with.
 *
 * IMPORTANT: this route MUST be registered AFTER any other static
 * "/compare/policies/<literal>" routes (e.g. /deep), otherwise Express will
 * greedily bind the literal segment to :sourceId and call getPolicy with
 * an invalid ID.
 */
// Literal sub-paths under /compare/policies/ that must NOT be parsed as a
// sourceId. If you add a new sibling route, add its first segment here too.
const POLICY_SUB_ROUTES = new Set(["deep"]);

compareRouter.get("/compare/policies/:sourceId/:destId?", async (req, res, next) => {
  try {
    if (POLICY_SUB_ROUTES.has(req.params.sourceId!)) {
      // Fall through to the literal handler registered after this one.
      next();
      return;
    }
    const src = requireContext("source");
    const dst = requireContext("dest");

    const sourcePolicy = await getPolicy(src.client, src.tenantId, req.params.sourceId!);

    let destPolicy: SophosPolicy | null = null;
    let ambiguous = false;
    if (req.params.destId) {
      destPolicy = await getPolicy(dst.client, dst.tenantId, req.params.destId);
    } else {
      const [sourceList, destList] = await Promise.all([
        listPolicies(src.client, src.tenantId),
        listPolicies(dst.client, dst.tenantId),
      ]);
      ({ dest: destPolicy, ambiguous } = pairPolicy(sourcePolicy, sourceList, destList));
    }

    if (!destPolicy) {
      res.json({
        sourcePolicy,
        destPolicy: null,
        changes: [],
        summary: { added: 0, removed: 0, changed: 0 },
        note: ambiguous
          ? "more than one policy matches this name ignoring case, so none is paired"
          : "no matching destination policy found",
        ambiguous,
      });
      return;
    }

    const fullDest = await getPolicy(dst.client, dst.tenantId, destPolicy.id);
    const [srcSettings, dstSettings] = await withProfileNames(
      sourcePolicy.settings ?? {},
      fullDest.settings ?? {},
      () => webProfileNames(src, dst),
    );
    const changes = diff(srcSettings, dstSettings);
    res.json({
      sourcePolicy,
      destPolicy: fullDest,
      // The settings as compared: web profile IDs swapped for profile names.
      settings: { source: srcSettings, dest: dstSettings },
      changes,
      summary: summarize(changes),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/compare/groups — name-level group comparison.
 */
compareRouter.get("/compare/groups", async (_req, res, next) => {
  try {
    const src = requireContext("source");
    const dst = requireContext("dest");
    const [s, d] = await Promise.all([
      listGroups(src.client, src.tenantId),
      listGroups(dst.client, dst.tenantId),
    ]);
    const sNames = new Set(s.map((g) => g.name));
    const dNames = new Set(d.map((g) => g.name));
    res.json({
      sourceOnly: s.filter((g) => !dNames.has(g.name)),
      destOnly: d.filter((g) => !sNames.has(g.name)),
      both: s.filter((g) => dNames.has(g.name)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/compare/exclusions — set-based diff per category.
 */
compareRouter.get("/compare/exclusions", async (_req, res, next) => {
  try {
    const src = requireContext("source");
    const dst = requireContext("dest");
    const [
      sScan,
      dScan,
      sAllow,
      dAllow,
      sBlock,
      dBlock,
    ] = await Promise.all([
      listScanningExclusions(src.client, src.tenantId),
      listScanningExclusions(dst.client, dst.tenantId),
      listAllowedItems(src.client, src.tenantId),
      listAllowedItems(dst.client, dst.tenantId),
      listBlockedItems(src.client, src.tenantId),
      listBlockedItems(dst.client, dst.tenantId),
    ]);

    res.json({
      scanning: setDiff(sScan, dScan, (x) => `${x.type}::${x.value}`),
      allowedItems: setDiff(sAllow, dAllow, (x) => `${x.type}::${JSON.stringify(x.properties ?? {})}`),
      blockedItems: setDiff(sBlock, dBlock, (x) => `${x.type}::${JSON.stringify(x.properties ?? {})}`),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/compare/policies/deep
 *
 * For every (source policy, dest policy) pair that pairPolicy() makes,
 * fetches the full settings on both sides and deep-diffs them. Returns a
 * per-policy match status. Cached in memory keyed by the source/dest tenant
 * IDs and invalidated when credentials change.
 *
 * Use ?refresh=true to force a recompute.
 */
compareRouter.get("/compare/policies/deep", async (req, res, next) => {
  try {
    const src = requireContext("source");
    const dst = requireContext("dest");
    const cacheKey = `${src.tenantId}::${dst.tenantId}`;
    const force = req.query.refresh === "true";

    if (
      !force &&
      deepMatchCache &&
      deepMatchCache.key === cacheKey &&
      deepMatchCache.result
    ) {
      res.json(deepMatchCache.result);
      return;
    }

    if (
      !force &&
      deepMatchCache &&
      deepMatchCache.key === cacheKey &&
      deepMatchCache.inFlight
    ) {
      const result = await deepMatchCache.inFlight;
      res.json(result);
      return;
    }

    const promise = computeDeepMatch();
    const entry = { key: cacheKey, inFlight: promise, result: null };
    deepMatchCache = entry;
    // Cache the result only if nothing cleared the cache while it ran: a
    // write in the meantime makes it stale.
    try {
      const result = await promise;
      if (deepMatchCache === entry) deepMatchCache = { key: cacheKey, inFlight: null, result };
      res.json(result);
    } catch (err) {
      if (deepMatchCache === entry) deepMatchCache = null;
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

export async function computeDeepMatch(): Promise<DeepPolicyMatchResult> {
  const startedAt = Date.now();
  const src = requireContext("source");
  const dst = requireContext("dest");

  log.emit("info", "compare", "computing deep policy match");

  const [sList, dList] = await Promise.all([
    listPolicies(src.client, src.tenantId),
    listPolicies(dst.client, dst.tenantId),
  ]);

  const matches: DeepPolicyMatch[] = [];
  const matchedPairs: Array<{ src: SophosPolicy; dst: SophosPolicy }> = [];
  const pairedDestIds = new Set<string>();

  for (const sPolicy of sList) {
    const dPolicy = pairPolicy(sPolicy, sList, dList).dest;
    if (dPolicy) {
      matchedPairs.push({ src: sPolicy, dst: dPolicy });
      pairedDestIds.add(dPolicy.id);
    } else {
      matches.push({
        type: sPolicy.type,
        name: sPolicy.name,
        sourceId: sPolicy.id,
        destId: null,
        status: "source-only",
        diffCount: 0,
      });
    }
  }
  for (const dPolicy of dList) {
    if (!pairedDestIds.has(dPolicy.id)) {
      matches.push({
        type: dPolicy.type,
        name: dPolicy.name,
        sourceId: null,
        destId: dPolicy.id,
        status: "dest-only",
        diffCount: 0,
      });
    }
  }

  // Web filtering profile names on both sides, looked up at most once per run
  // and only when a policy refers to a profile.
  let profileNamesPromise: Promise<[Map<string, string>, Map<string, string>]> | undefined;
  const profileNames = () => (profileNamesPromise ??= webProfileNames(src, dst));

  // Concurrency-limited deep fetch + diff for the matched pairs.
  const queue = [...matchedPairs];
  const runOne = async (pair: { src: SophosPolicy; dst: SophosPolicy }) => {
    try {
      const [srcFull, dstFull] = await Promise.all([
        getPolicy(src.client, src.tenantId, pair.src.id),
        getPolicy(dst.client, dst.tenantId, pair.dst.id),
      ]);
      const [srcSettings, dstSettings] = await withProfileNames(
        srcFull.settings ?? {},
        dstFull.settings ?? {},
        profileNames,
      );
      const settingsChanges = diff(srcSettings, dstSettings);
      // Priority is left out: a clone lands at the bottom of the
      // destination's order, so its priority differs by design.
      const metaChanges = diff(
        {
          enabled: srcFull.enabled,
          enforced: srcFull.enforced,
        },
        {
          enabled: dstFull.enabled,
          enforced: dstFull.enforced,
        },
      );
      const total = settingsChanges.length + metaChanges.length;
      matches.push({
        type: pair.src.type,
        name: pair.src.name,
        sourceId: pair.src.id,
        destId: pair.dst.id,
        status: total === 0 ? "match" : "differ",
        diffCount: total,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.emit(
        "warn",
        "compare",
        `deep fetch failed for ${pair.src.type}/${pair.src.name}: ${message}`,
      );
      // Treat fetch failures as "differ" so the row is NOT hidden by the toggle.
      matches.push({
        type: pair.src.type,
        name: pair.src.name,
        sourceId: pair.src.id,
        destId: pair.dst.id,
        status: "differ",
        diffCount: -1,
      });
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < DEEP_MATCH_CONCURRENCY; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) await runOne(next);
        }
      })(),
    );
  }
  await Promise.all(workers);

  matches.sort((a, b) =>
    `${a.type}::${a.name}`.localeCompare(`${b.type}::${b.name}`),
  );

  const byType: Record<string, DeepPolicyMatch[]> = {};
  for (const m of matches) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type]!.push(m);
  }

  const durationMs = Date.now() - startedAt;
  log.emit(
    "info",
    "compare",
    `deep policy match complete: ${matches.length} policies in ${durationMs}ms`,
  );

  return {
    computedAt: new Date().toISOString(),
    durationMs,
    matches,
    byType,
  };
}

/**
 * A tenant's web filtering profile names by ID. A failed lookup gives an
 * empty map, so that side's IDs are compared as they are and still show as a
 * change.
 */
async function profileNamesById(
  ctx: TenantContext,
  side: TenantLabel,
): Promise<Map<string, string>> {
  try {
    const profiles = await listProfiles(ctx.client, ctx.tenantId);
    return new Map(profiles.map((p) => [p.id, p.name]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.emit(
      "warn",
      "compare",
      `web filtering profile lookup failed, so web profile IDs are compared as they are: ${message}`,
      { side },
    );
    return new Map();
  }
}

/**
 * Both tenants' profile names by ID, with one name for each profile. Names
 * match trimmed and in any case, the way the policy migrator maps them, and
 * a profile on both sides shows the source's name on each, so a correct clone
 * reads the same on both.
 */
async function webProfileNames(
  src: TenantContext,
  dst: TenantContext,
): Promise<[Map<string, string>, Map<string, string>]> {
  const [s, d] = await Promise.all([profileNamesById(src, "source"), profileNamesById(dst, "dest")]);
  const key = (name: string) => name.trim().toLowerCase();
  const shown = new Map<string, string>();
  for (const name of [...s.values(), ...d.values()]) {
    if (!shown.has(key(name))) shown.set(key(name), name.trim());
  }
  const named = (m: Map<string, string>) => new Map([...m].map(([id, name]) => [id, shown.get(key(name))!]));
  return [named(s), named(d)];
}

/** Both policies' settings with web profile IDs swapped for names, when either names a profile. */
async function withProfileNames(
  srcSettings: Record<string, unknown>,
  dstSettings: Record<string, unknown>,
  names: () => Promise<[Map<string, string>, Map<string, string>]>,
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  if (!refersToWebProfile(srcSettings) && !refersToWebProfile(dstSettings)) return [srcSettings, dstSettings];
  const [srcNames, dstNames] = await names();
  return [webProfilesByName(srcSettings, srcNames), webProfilesByName(dstSettings, dstNames)];
}

const isWebProfileKey = (key: string) =>
  key.endsWith(WEB_PROFILE_ID_SUFFIX) || key.endsWith(WEB_PROFILE_SCHEDULES_SUFFIX);

/** True when the web profile ID or schedule setting holds a value. */
function refersToWebProfile(settings: Record<string, unknown>): boolean {
  return Object.keys(settings).some((key) => {
    if (!isWebProfileKey(key)) return false;
    const v = (settings[key] as { value?: unknown } | undefined)?.value;
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "";
  });
}

/**
 * Web control policies name their web filtering profile by ID, in the web
 * profile ID setting and inside the schedule, and a profile's ID differs on
 * each tenant. Swap every ID the tenant knows for the profile's name so a
 * correct clone compares equal. An ID the tenant doesn't know is left as it
 * is, so it still shows as a change.
 */
function webProfilesByName(
  settings: Record<string, unknown>,
  nameById: Map<string, string>,
): Record<string, unknown> {
  const swap = (v: unknown): unknown => {
    if (typeof v === "string") {
      return nameById.get(v) ?? v;
    }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, inner]) => [k, swap(inner)]));
    }
    return v;
  };
  const out = { ...settings };
  for (const key of Object.keys(out)) {
    if (isWebProfileKey(key)) out[key] = swap(out[key]);
  }
  return out;
}

function setDiff<T>(source: T[], dest: T[], keyFn: (item: T) => string) {
  const sKeys = new Map(source.map((x) => [keyFn(x), x]));
  const dKeys = new Map(dest.map((x) => [keyFn(x), x]));
  const sourceOnly: T[] = [];
  const destOnly: T[] = [];
  const both: T[] = [];
  for (const [k, v] of sKeys) {
    if (dKeys.has(k)) both.push(v);
    else sourceOnly.push(v);
  }
  for (const [k, v] of dKeys) {
    if (!sKeys.has(k)) destOnly.push(v);
  }
  return { sourceOnly, destOnly, both };
}
