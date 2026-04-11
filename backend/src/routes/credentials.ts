/**
 * Routes for viewing, editing, and testing credentials.
 * Supports both "direct" (two tenant-scoped cred sets) and "partner"
 * (one partner cred set + two tenant-ID picks) modes.
 */

import { Router } from "express";
import {
  getCredentialsView,
  getStatusPayload,
  getPartnerTenants,
  saveDirectCredentials,
  savePartnerCredentials,
} from "../state.js";
import {
  createDirectContext,
  createPartnerContext,
  type TenantLabel,
} from "../sophos/tenant-context.js";
import { log } from "../log.js";

export const credentialsRouter = Router();

credentialsRouter.get("/credentials", (_req, res) => {
  res.json(getCredentialsView());
});

/**
 * PUT /api/credentials — persist credentials and rebuild contexts.
 *
 * Direct mode body: { mode: "direct", source?: {...}, dest?: {...} }
 * Partner mode body: { mode: "partner", clientId, clientSecret, label?,
 *                      sourceTenantId?, sourceLabel?, destTenantId?, destLabel? }
 */
credentialsRouter.put("/credentials", async (req, res) => {
  const body = req.body ?? {};
  const mode = body.mode ?? "direct";

  try {
    if (mode === "partner") {
      await savePartnerCredentials({
        clientId: str(body.clientId),
        clientSecret: str(body.clientSecret),
        label: str(body.label),
        sourceTenantId: str(body.sourceTenantId),
        sourceLabel: str(body.sourceLabel),
        destTenantId: str(body.destTenantId),
        destLabel: str(body.destLabel),
      });
    } else {
      await saveDirectCredentials({
        source: body.source
          ? {
              clientId: str(body.source.clientId),
              clientSecret: str(body.source.clientSecret),
              label: str(body.source.label),
            }
          : undefined,
        dest: body.dest
          ? {
              clientId: str(body.dest.clientId),
              clientSecret: str(body.dest.clientSecret),
              label: str(body.dest.label),
            }
          : undefined,
      });
    }
  } catch (err) {
    log.error("[credentials:PUT] save failed", err);
    res.status(500).json({
      error: "save_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  res.json({ ok: true, status: getStatusPayload() });
});

/**
 * POST /api/credentials/test — verify a credential set without persisting.
 * Accepts { mode:"direct", label?, clientId, clientSecret }
 *    or   { mode:"partner", clientId, clientSecret }
 */
credentialsRouter.post("/credentials/test", async (req, res) => {
  const body = req.body ?? {};
  const mode = body.mode ?? "direct";

  if (!body.clientId || !body.clientSecret) {
    res.status(400).json({
      error: "bad_request",
      message: "clientId and clientSecret are required.",
    });
    return;
  }

  try {
    if (mode === "partner") {
      const pctx = await createPartnerContext({
        clientId: body.clientId,
        clientSecret: body.clientSecret,
      });
      res.json({
        ok: true,
        idType: pctx.identity.idType,
        tenantCount: pctx.tenants.length,
        tenants: pctx.tenants.map((t) => ({
          id: t.id,
          name: t.name,
          dataRegion: t.dataRegion,
        })),
      });
    } else {
      const label: TenantLabel =
        body.label === "dest" ? "dest" : "source";
      const ctx = await createDirectContext(label, {
        clientId: body.clientId,
        clientSecret: body.clientSecret,
      });
      res.json({ ok: true, identity: ctx.summary });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[credentials:test] ${message}`);
    res.status(400).json({ ok: false, error: "auth_failed", message });
  }
});

/**
 * GET /api/partner/tenants — return the cached tenant list (partner mode only).
 */
credentialsRouter.get("/partner/tenants", (_req, res) => {
  const tenants = getPartnerTenants();
  res.json({ items: tenants });
});

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}
