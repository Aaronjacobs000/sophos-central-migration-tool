/**
 * Refuses requests that name another host. Listening on 127.0.0.1 keeps the
 * network out, but not a page in the user's own browser: with DNS rebinding,
 * a site points its own name at 127.0.0.1 and its page can then read every
 * API answer and send JSON, as if it were the tool's own page. Its requests
 * still carry its own name in Host, so only loopback names are accepted
 * there, plus any set in ALLOWED_HOSTS (comma-separated, for a reverse proxy
 * that passes its own name on, or a name people browse to). When HOST opens
 * the server to the network, this computer's own IP addresses are accepted
 * too: DNS rebinding needs a name the attacker controls, and a bare IP address
 * isn't one. A request that changes something must also come from the tool's
 * own page when the browser says where it came from (Origin): the same host
 * and port as Host, so another web app on this computer can't make changes.
 * The one other Origin taken is a name in ALLOWED_HOSTS on its default port,
 * for a reverse proxy that sends its own address on as Host.
 */

import net from "node:net";
import type { Request, Response, NextFunction } from "express";
import { listensBeyondLoopback, ownAddresses } from "../config/network.js";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

function extraHosts(): Set<string> {
  return new Set(
    (process.env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function allowedHosts(beyondLoopback: boolean, extra: Set<string>): Set<string> {
  const hosts = new Set([...LOOPBACK, ...extra]);
  if (beyondLoopback) {
    // In the form a Host header reads as, so [fd00::1] matches [FD00:0::1].
    for (const ip of ownAddresses()) {
      const name = hostName(net.isIPv6(ip) ? `[${ip}]` : ip);
      if (name) hosts.add(name);
    }
  }
  return hosts;
}

/** The host name in a Host header, without the port. Null when it can't be read. */
function hostName(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The port written in a Host header, or null when it names none. */
function hostPort(value: string): string | null {
  const match = /:(\d+)$/.exec(value.replace(/^\[[^\]]*\]/, ""));
  return match ? String(Number(match[1])) : null;
}

/**
 * True when a change may come from this Origin. A page at the host the request
 * was sent to must also be on its port; a Host with no port is on the default
 * port of the Origin's scheme, as the browser left it out. A page at another
 * host passes only for an ALLOWED_HOSTS name on its default port.
 */
function originAllowed(origin: string, host: string, hostHeader: string, extra: Set<string>): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (!defaultPort || !url.hostname) return false;
  const name = url.hostname.toLowerCase();
  if (name === host) return (url.port || defaultPort) === (hostPort(hostHeader) ?? defaultPort);
  return extra.has(name) && url.port === "";
}

export function localHostOnly(req: Request, res: Response, next: NextFunction): void {
  const beyondLoopback = listensBeyondLoopback();
  const extra = extraHosts();
  const allowed = allowedHosts(beyondLoopback, extra);
  const host = hostName(req.headers.host ?? "");
  if (!host || !allowed.has(host)) {
    const message = beyondLoopback
      ? "Open the tool at this computer's IP address, or add the name you used to ALLOWED_HOSTS."
      : "Open the tool at http://127.0.0.1 or http://localhost.";
    res.status(403).json({ error: "forbidden_host", message });
    return;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !SAFE_METHODS.has(req.method)) {
    if (!originAllowed(origin, host, req.headers.host ?? "", extra)) {
      res.status(403).json({ error: "forbidden_origin", message: "Changes are accepted only from the tool's own pages." });
      return;
    }
  }
  next();
}
