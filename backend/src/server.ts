import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";

import { initState } from "./state.js";
import { log } from "./log.js";
import { errorHandler } from "./middleware/error-handler.js";
import { statusRouter } from "./routes/status.js";
import { credentialsRouter } from "./routes/credentials.js";
import { policiesRouter } from "./routes/policies.js";
import { groupsRouter } from "./routes/groups.js";
import { exclusionsRouter } from "./routes/exclusions.js";
import { endpointsRouter } from "./routes/endpoints.js";
import { compareRouter } from "./routes/compare.js";
import { migrateConfigRouter } from "./routes/migrate-config.js";
import { migrateDevicesRouter } from "./routes/migrate-devices.js";
import { preloadRouter } from "./routes/preload.js";
import { logsRouter } from "./routes/logs.js";
import { searchRouter } from "./routes/search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is two levels up from backend/dist/ at runtime.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Load .env from the repo root. Missing file is fine - server boots in
// "unconfigured" state and the welcome wizard handles first-run setup.
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

async function main() {
  await initState(REPO_ROOT);

  const PORT = Number(process.env.PORT ?? 3100);
  const HOST = "127.0.0.1";

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // --- Always-available API (no requireConfigured guard) ---
  app.use("/api", statusRouter);
  app.use("/api", credentialsRouter);

  // --- Specific routers FIRST so /api/compare/* and /api/migrate/* don't
  //     get matched by the per-side resource routers (which would treat
  //     "compare" or "migrate" as a :side path param value).
  app.use("/api", compareRouter);
  app.use("/api", migrateConfigRouter);
  app.use("/api", migrateDevicesRouter);
  app.use("/api", preloadRouter);
  app.use("/api", logsRouter);
  app.use("/api", searchRouter);

  // --- Per-side resource APIs (guarded by requireConfigured) ---
  app.use("/api", policiesRouter);
  app.use("/api", groupsRouter);
  app.use("/api", exclusionsRouter);
  app.use("/api", endpointsRouter);

  // --- Static frontend ---
  const FRONTEND_DIR = path.join(REPO_ROOT, "frontend");
  app.use(express.static(FRONTEND_DIR, { index: "index.html" }));

  // SPA-ish fallback: any non-API GET falls through to index.html so the
  // client-side router can redirect to the welcome wizard when unconfigured.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });

  app.use(errorHandler);

  app.listen(PORT, HOST, () => {
    log.info(`listening on http://${HOST}:${PORT} (repo: ${REPO_ROOT})`);
  });
}

main().catch((err) => {
  log.error("fatal startup error", err);
  process.exit(1);
});
