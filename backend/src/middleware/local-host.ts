/**
 * Refuses requests that name another host. Listening on 127.0.0.1 keeps the
 * network out, but not a page in the user's own browser: with DNS rebinding,
 * a site points its own name at 127.0.0.1 and its page can then read every
 * API answer and send JSON, as if it were the tool's own page. Its requests
 * still carry its own name in Host, so only loopback names are accepted
 * there, plus any set in ALLOWED_HOSTS (comma-separated, for a reverse proxy
 * that passes its own name on). A request that changes something must also
 * come from a page on one of those hosts when the browser says where it came
 * from (Origin).
 */

import type { Request, Response, NextFunction } from "express";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedHosts(): Set<string> {
  const extra = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...LOOPBACK, ...extra]);
}

/** The host name in a Host header or an Origin, without the port. Null when it can't be read. */
function hostName(value: string, withScheme: boolean): string | null {
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function localHostOnly(req: Request, res: Response, next: NextFunction): void {
  const allowed = allowedHosts();
  const host = hostName(req.headers.host ?? "", false);
  if (!host || !allowed.has(host)) {
    res.status(403).json({ error: "forbidden_host", message: "Open the tool at http://127.0.0.1 or http://localhost." });
    return;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !SAFE_METHODS.has(req.method)) {
    const from = hostName(origin, true);
    if (!from || !allowed.has(from)) {
      res.status(403).json({ error: "forbidden_origin", message: "Changes are accepted only from the tool's own pages." });
      return;
    }
  }
  next();
}
