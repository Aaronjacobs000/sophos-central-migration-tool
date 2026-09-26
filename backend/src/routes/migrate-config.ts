/**
 * POST /api/migrate/policies, /api/migrate/groups, /api/migrate/user-groups,
 * /api/migrate/exclusions
 *
 * Each accepts dryRun mode via body or `?dryRun=true` query.
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import { migratePolicies } from "../services/policy-migrator.js";
import { mirrorGroups, mirrorUserGroups } from "../services/group-mirror.js";
import { copyExclusions, EXCLUSION_TYPES, type ExclusionType } from "../services/exclusion-copier.js";

export const migrateConfigRouter = Router();

migrateConfigRouter.use("/migrate", requireConfigured);

function isDryRun(req: any): boolean {
  return req.query?.dryRun === "true" || req.body?.dryRun === true;
}

migrateConfigRouter.post("/migrate/policies", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.policyIds) ? req.body.policyIds : [];
    if (!ids.length) {
      res.status(400).json({ error: "bad_request", message: "policyIds[] required" });
      return;
    }
    const results = await migratePolicies({
      policyIds: ids,
      overwrite: req.body?.overwrite === true,
      dryRun: isDryRun(req),
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

migrateConfigRouter.post("/migrate/groups", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    if (!ids.length) {
      res.status(400).json({ error: "bad_request", message: "groupIds[] required" });
      return;
    }
    const results = await mirrorGroups({
      groupIds: ids,
      dryRun: isDryRun(req),
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

migrateConfigRouter.post("/migrate/user-groups", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.userGroupIds) ? req.body.userGroupIds : [];
    if (!ids.length) {
      res.status(400).json({ error: "bad_request", message: "userGroupIds[] required" });
      return;
    }
    const results = await mirrorUserGroups({
      userGroupIds: ids,
      dryRun: isDryRun(req),
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

migrateConfigRouter.post("/migrate/exclusions", async (req, res, next) => {
  try {
    const sel = req.body?.selections ?? {};
    if (!sel || typeof sel !== "object") {
      res.status(400).json({ error: "bad_request", message: "selections required" });
      return;
    }
    // Sanitise: only allow the known types
    const cleaned: Partial<Record<ExclusionType, string[]>> = {};
    for (const t of EXCLUSION_TYPES) {
      if (Array.isArray(sel[t])) cleaned[t] = sel[t];
    }
    const results = await copyExclusions({
      selections: cleaned,
      dryRun: isDryRun(req),
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});
