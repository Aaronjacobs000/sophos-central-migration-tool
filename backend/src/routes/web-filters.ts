/**
 * Web filtering site lists and profiles.
 *   GET  /api/:side/web-filters/site-lists
 *   GET  /api/:side/web-filters/profiles
 *   POST /api/migrate/web-filters   { siteListIds, profileIds, dryRun }
 */

import { Router } from "express";
import { sideParam } from "../middleware/side-param.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { listSiteLists, listProfiles } from "../sophos/api/web-filters.js";
import { copyWebFilters } from "../services/web-filter-copier.js";

export const webFiltersRouter = Router();
export const migrateWebFiltersRouter = Router();

webFiltersRouter.use("/:side/web-filters", requireConfigured, sideParam);

webFiltersRouter.get("/:side/web-filters/site-lists", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    res.json({ items: await listSiteLists(ctx.client, ctx.tenantId) });
  } catch (err) {
    next(err);
  }
});

webFiltersRouter.get("/:side/web-filters/profiles", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    res.json({ items: await listProfiles(ctx.client, ctx.tenantId) });
  } catch (err) {
    next(err);
  }
});

migrateWebFiltersRouter.use("/migrate/web-filters", requireConfigured);

migrateWebFiltersRouter.post("/migrate/web-filters", async (req, res, next) => {
  try {
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const siteListIds = strings(req.body?.siteListIds);
    const profileIds = strings(req.body?.profileIds);
    if (!siteListIds.length && !profileIds.length) {
      res.status(400).json({ error: "bad_request", message: "siteListIds[] or profileIds[] required" });
      return;
    }
    const dryRun = req.query?.dryRun === "true" || req.body?.dryRun === true;
    res.json({ results: await copyWebFilters({ siteListIds, profileIds, dryRun }) });
  } catch (err) {
    next(err);
  }
});
