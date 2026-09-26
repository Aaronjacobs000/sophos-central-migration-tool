/**
 * Guards for routes that change something. A page on another site can post a
 * form, or plain text, to 127.0.0.1 without the browser asking first, but not
 * a JSON request: that needs a CORS preflight, which this server never
 * answers. express.json() leaves any other body unparsed, so without these
 * guards such a post reaches the route as an empty body.
 */

import type { Request, Response, NextFunction } from "express";

/** Accept JSON requests only. */
export function jsonOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "unsupported_media_type", message: "Send JSON." });
    return;
  }
  next();
}

/** JSON only, and the body must be an object with at least one field. */
export function jsonBody(req: Request, res: Response, next: NextFunction): void {
  jsonOnly(req, res, () => {
    const body = req.body as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
      res.status(400).json({ error: "bad_request", message: "A JSON body is required." });
      return;
    }
    next();
  });
}
