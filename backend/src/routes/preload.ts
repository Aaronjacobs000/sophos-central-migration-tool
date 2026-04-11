/**
 * Preload status + cached data routes. The UI uses these to:
 *   - Show a per-section status grid on the dashboard
 *   - Render list pages instantly from the cache (instead of waiting on a
 *     fresh round-trip to Sophos)
 *   - Manually refresh a single section if it failed
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import {
  getPreloadStatus,
  getSectionData,
  refreshSection,
  startPreload,
  SECTIONS,
  type SectionId,
} from "../services/preloader.js";

export const preloadRouter = Router();

preloadRouter.use("/preload", requireConfigured);

preloadRouter.get("/preload/status", (_req, res) => {
  res.json(getPreloadStatus());
});

preloadRouter.post("/preload/start", (_req, res) => {
  startPreload();
  res.json({ ok: true, status: getPreloadStatus() });
});

preloadRouter.get("/preload/data/:section/:side", (req, res) => {
  const { section, side } = req.params;
  if (side !== "source" && side !== "dest") {
    res.status(400).json({ error: "bad_side" });
    return;
  }
  if (!SECTIONS.includes(section as SectionId)) {
    res.status(400).json({ error: "bad_section" });
    return;
  }
  const result = getSectionData(side, section as SectionId);
  res.json(result);
});

preloadRouter.post("/preload/refresh/:section/:side", async (req, res, next) => {
  try {
    const { section, side } = req.params;
    if (side !== "source" && side !== "dest") {
      res.status(400).json({ error: "bad_side" });
      return;
    }
    if (!SECTIONS.includes(section as SectionId)) {
      res.status(400).json({ error: "bad_section" });
      return;
    }
    const status = await refreshSection(side, section as SectionId);
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});
