/**
 * Read-only pre-flight checks for the Start migration page.
 *   GET  /api/checks/migration-window?direction=source-to-dest
 *   POST /api/checks/licenses   { endpointIds, direction }
 * Both only read from Sophos. The licence check is a POST because the
 * selection can be long.
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import { checkMigrationWindow } from "../services/migration-window.js";
import { checkLicenses } from "../services/license-check.js";
import type { MigrationDirection } from "../services/device-migrator.js";

export const checksRouter = Router();

checksRouter.use("/checks", requireConfigured);

function direction(value: unknown): MigrationDirection {
  return value === "dest-to-source" ? "dest-to-source" : "source-to-dest";
}

checksRouter.get("/checks/migration-window", async (req, res, next) => {
  try {
    res.json(await checkMigrationWindow(direction(req.query.direction)));
  } catch (err) {
    next(err);
  }
});

checksRouter.post("/checks/licenses", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.endpointIds)
      ? req.body.endpointIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    res.json(await checkLicenses({ endpointIds: ids, direction: direction(req.body?.direction) }));
  } catch (err) {
    next(err);
  }
});
