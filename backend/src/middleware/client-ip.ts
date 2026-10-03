/**
 * Answers only the clients in ALLOWED_IPS, plus this computer. Mounted first,
 * so a refused client gets no page, API answer or live job stream. The
 * address is the connection's own (never X-Forwarded-For). Behind a reverse
 * proxy on this computer every client is the proxy, so restrict there instead.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { normaliseIp, type IpAllowList } from "../config/network.js";

/** With no list, every client that can connect is answered. */
export function allowedClientsOnly(list: IpAllowList | null): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const address = req.socket.remoteAddress ?? "";
    if (!list || list.allows(address)) {
      next();
      return;
    }
    res.status(403).json({
      error: "forbidden_client",
      message: `This computer's address (${normaliseIp(address) ?? "unknown"}) is not in the tool's ALLOWED_IPS.`,
    });
  };
}
