/**
 * Machine search routes. Searches for endpoints by hostname across:
 *   - Direct mode: source + dest tenants
 *   - Partner mode: optionally ALL managed tenants or a specific subset
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import { getState, getPartnerContext, requireContext } from "../state.js";
import { listEndpoints } from "../sophos/api/endpoints.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";

export const searchRouter = Router();

searchRouter.use("/search", requireConfigured);

interface SearchResult {
  tenantId: string;
  tenantName: string | null;
  side: "source" | "dest" | "other";
  endpoint: SophosEndpoint;
}

/**
 * GET /api/search/endpoints?q=hostname&scope=source-dest|all
 *
 * scope=source-dest (default): searches source + dest only.
 * scope=all (partner mode only): searches every managed tenant.
 */
searchRouter.get("/search/endpoints", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({
        error: "bad_request",
        message: "q (hostname search) is required",
      });
      return;
    }

    const scope = req.query.scope === "all" ? "all" : "source-dest";
    const state = getState();
    const results: SearchResult[] = [];

    if (scope === "all" && state.partner) {
      // Search across ALL partner-managed tenants
      const pctx = getPartnerContext()!;
      const CONCURRENCY = 5;
      const queue = [...pctx.tenants];
      const workers: Promise<void>[] = [];

      for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(
          (async () => {
            while (queue.length > 0) {
              const tenant = queue.shift();
              if (!tenant) break;
              try {
                const page = await listEndpoints(
                  pctx.client,
                  tenant.id,
                  { hostnameContains: q, pageSize: 50 },
                );
                const side =
                  tenant.id === state.source?.tenantId
                    ? "source"
                    : tenant.id === state.dest?.tenantId
                      ? "dest"
                      : "other";
                for (const ep of page.items) {
                  results.push({
                    tenantId: tenant.id,
                    tenantName: tenant.name,
                    side,
                    endpoint: ep,
                  });
                }
              } catch {
                // Skip tenants that error (permissions, etc.)
              }
            }
          })(),
        );
      }
      await Promise.all(workers);
    } else {
      // Search source + dest
      const sides: Array<{ label: "source" | "dest"; ctx: ReturnType<typeof requireContext> | null }> = [
        { label: "source", ctx: state.source },
        { label: "dest", ctx: state.dest },
      ];
      await Promise.all(
        sides.map(async ({ label, ctx }) => {
          if (!ctx) return;
          try {
            const page = await listEndpoints(ctx.client, ctx.tenantId, {
              hostnameContains: q,
              pageSize: 100,
            });
            for (const ep of page.items) {
              results.push({
                tenantId: ctx.tenantId,
                tenantName: ctx.summary.displayName,
                side: label,
                endpoint: ep,
              });
            }
          } catch {
            // Best effort
          }
        }),
      );
    }

    results.sort((a, b) =>
      (a.endpoint.hostname ?? "").localeCompare(b.endpoint.hostname ?? ""),
    );

    res.json({ q, scope, items: results });
  } catch (err) {
    next(err);
  }
});
