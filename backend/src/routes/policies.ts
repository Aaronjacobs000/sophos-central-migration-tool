import { Router } from "express";
import { sideParam } from "../middleware/side-param.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { jsonBody } from "../middleware/json-body.js";
import {
  listPolicies,
  getPolicy,
  createPolicy,
  clonePolicy,
  updatePolicy,
  deletePolicy,
} from "../sophos/api/policies.js";
import { auditedDelete, auditedWrite } from "../services/audit-log.js";

export const policiesRouter = Router();

policiesRouter.use("/:side/policies", requireConfigured, sideParam);

policiesRouter.get("/:side/policies", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const policyType =
      typeof req.query.policyType === "string" ? req.query.policyType : undefined;
    const items = await listPolicies(ctx.client, ctx.tenantId, { policyType });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

policiesRouter.get("/:side/policies/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const policy = await getPolicy(ctx.client, ctx.tenantId, req.params.id!);
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

policiesRouter.post("/:side/policies", jsonBody, async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const created = await auditedWrite(ctx, "create", "policy", undefined,
      () => createPolicy(ctx.client, ctx.tenantId, req.body), { name: req.body?.name, type: req.body?.type });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

policiesRouter.post("/:side/policies/:id/clone", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const newName = String(req.body?.name ?? "");
    if (!newName) {
      res.status(400).json({ error: "bad_request", message: "name required" });
      return;
    }
    const cloned = await auditedWrite(ctx, "clone", "policy", undefined,
      () => clonePolicy(ctx.client, ctx.tenantId, req.params.id!, newName), { sourceId: req.params.id, name: newName });
    res.status(201).json(cloned);
  } catch (err) {
    next(err);
  }
});

policiesRouter.patch("/:side/policies/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const updated = await auditedWrite(ctx, "update", "policy", req.params.id!,
      () => updatePolicy(ctx.client, ctx.tenantId, req.params.id!, req.body),
      { fields: Object.keys(req.body ?? {}), settings: Object.keys(req.body?.settings ?? {}) });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

policiesRouter.delete("/:side/policies/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    await auditedDelete(ctx, "policy", req.params.id!, () => deletePolicy(ctx.client, ctx.tenantId, req.params.id!));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
