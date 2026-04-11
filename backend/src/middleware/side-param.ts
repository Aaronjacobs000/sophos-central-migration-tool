/**
 * Validates the :side path param and stashes the resolved tenant context
 * on res.locals so route handlers can use it without re-parsing.
 */

import type { Request, Response, NextFunction } from "express";
import { requireContext } from "../state.js";
import type { TenantContext } from "../sophos/tenant-context.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      tenantContext?: TenantContext;
    }
  }
}

export function sideParam(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const side = req.params.side;
  if (side !== "source" && side !== "dest") {
    // Don't error out — this router was matched because Express greedily
    // bound :side to a literal segment like "compare" or "migrate". Skip
    // out so the next router in the parent stack gets a chance.
    next("router");
    return;
  }
  try {
    res.locals.tenantContext = requireContext(side);
    next();
  } catch (err) {
    res.status(503).json({
      error: "tenant_unavailable",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
