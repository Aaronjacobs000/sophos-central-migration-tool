/**
 * Guards routes that need both tenant contexts to be live. The frontend
 * treats a 409 with body {error:"unconfigured"} as its signal to redirect
 * to the welcome wizard.
 */

import type { Request, Response, NextFunction } from "express";
import { getState } from "../state.js";

export function requireConfigured(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const state = getState();
  if (state.status === "unconfigured") {
    res.status(409).json({ error: "unconfigured" });
    return;
  }
  if (state.status === "configured-invalid") {
    res.status(503).json({
      error: "configured-invalid",
      detail: state.lastError,
    });
    return;
  }
  next();
}
