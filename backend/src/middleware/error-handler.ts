/**
 * Unified JSON error response for uncaught route errors.
 */

import type { Request, Response, NextFunction } from "express";
import { log } from "../log.js";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(`[${req.method} ${req.path}] ${message}`);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error", message });
}
