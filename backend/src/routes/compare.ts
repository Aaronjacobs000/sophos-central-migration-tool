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
import { diff, summarize } from "../compare/json-diff.js";
import { log } from "../log.js";
import type { SophosPolicy } from "../sophos/types/migration.js";

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
 * GET /api/compare/policies — list-level diff: which policy names+types
 * exist on source only, dest only, or both.
 */
compareRouter.get("/compare/policies", async (_req, res, next) => {
  try {
    const src = requireContext("source");
    const dst = requireContext("dest");
    const [s, d] = await Promise.all([
      listPolicies(src.client, src.tenantId),
      listPolicies(dst.client, dst.tenantId),
    ]);

    const key = (p: SophosPolicy) => `${p.type}::${p.name}`;
    const sMap = new Map(s.map((p) => [key(p), p]));
    const dMap = new Map(d.map((p) => [key(p), p]));

    const sourceOnly: SophosPolicy[] = [];
    const destOnly: SophosPolicy[] = [];
    const both: Array<{ source: SophosPolicy; dest: SophosPolicy }> = [];

    for (const [k, sp] of sMap) {
      const dp = dMap.get(k);
      if (dp) both.push({ source: sp, dest: dp });
      else sourceOnly.push(sp);
    }
    for (const [k, dp] of dMap) {
      if (!sMap.has(k)) destOnly.push(dp);
    }

    res.json({ sourceOnly, destOnly, both });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/compare/policies/:sourceId/:destId? — deep diff between two
 * policies' settings. If destId is omitted, attempts to find a destination
 * policy with the same name+type.
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
    if (req.params.destId) {
      destPolicy = await getPolicy(dst.client, dst.tenantId, req.params.destId);
    } else {
      const destList = await listPolicies(dst.client, dst.tenantId);
      destPolicy =
        destList.find(
          (p) => p.name === sourcePolicy.name && p.type === sourcePolicy.type,
        ) ?? null;
    }

    if (!destPolicy) {
      res.json({
        sourcePolicy,
        destPolicy: null,
        changes: [],
        summary: { added: 0, removed: 0, changed: 0 },
        note: "no matching destination policy found",
      });
      return;
    }

    const fullDest = await getPolicy(dst.client, dst.tenantId, destPolicy.id);
    const changes = diff(sourcePolicy.settings ?? {}, fullDest.settings ?? {});
    res.json({
      sourcePolicy,
      destPolicy: fullDest,
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
 * For every (source policy, dest policy) pair that matches by name+type,
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
    deepMatchCache = { key: cacheKey, inFlight: promise, result: null };
    try {
      const result = await promise;
      deepMatchCache = { key: cacheKey, inFlight: null, result };
      res.json(result);
    } catch (err) {
      deepMatchCache = null;
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

async function computeDeepMatch(): Promise<DeepPolicyMatchResult> {
  const startedAt = Date.now();
  const src = requireContext("source");
  const dst = requireContext("dest");

  log.emit("info", "compare", "computing deep policy match");

  const [sList, dList] = await Promise.all([
    listPolicies(src.client, src.tenantId),
    listPolicies(dst.client, dst.tenantId),
  ]);

  const key = (p: SophosPolicy) => `${p.type}::${p.name}`;
  const sMap = new Map(sList.map((p) => [key(p), p]));
  const dMap = new Map(dList.map((p) => [key(p), p]));

  const matches: DeepPolicyMatch[] = [];
  const matchedPairs: Array<{ src: SophosPolicy; dst: SophosPolicy }> = [];

  for (const [k, sPolicy] of sMap) {
    const dPolicy = dMap.get(k);
    if (dPolicy) {
      matchedPairs.push({ src: sPolicy, dst: dPolicy });
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
  for (const [k, dPolicy] of dMap) {
    if (!sMap.has(k)) {
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

  // Concurrency-limited deep fetch + diff for the matched pairs.
  const queue = [...matchedPairs];
  const runOne = async (pair: { src: SophosPolicy; dst: SophosPolicy }) => {
    try {
      const [srcFull, dstFull] = await Promise.all([
        getPolicy(src.client, src.tenantId, pair.src.id),
        getPolicy(dst.client, dst.tenantId, pair.dst.id),
      ]);
      const settingsChanges = diff(
        srcFull.settings ?? {},
        dstFull.settings ?? {},
      );
      const metaChanges = diff(
        {
          enabled: srcFull.enabled,
          priority: srcFull.priority,
          enforced: srcFull.enforced,
        },
        {
          enabled: dstFull.enabled,
          priority: dstFull.priority,
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
