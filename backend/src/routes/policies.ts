import { Router } from "express";
import { sideParam } from "../middleware/side-param.js";
import { requireConfigured } from "../middleware/require-configured.js";
import {
  listPolicies,
  getPolicy,
  createPolicy,
  clonePolicy,
  updatePolicy,
  deletePolicy,
} from "../sophos/api/policies.js";

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

policiesRouter.post("/:side/policies", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const created = await createPolicy(ctx.client, ctx.tenantId, req.body);
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
    const cloned = await clonePolicy(ctx.client, ctx.tenantId, req.params.id!, newName);
    res.status(201).json(cloned);
  } catch (err) {
    next(err);
  }
});

policiesRouter.patch("/:side/policies/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const updated = await updatePolicy(ctx.client, ctx.tenantId, req.params.id!, req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

policiesRouter.delete("/:side/policies/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    await deletePolicy(ctx.client, ctx.tenantId, req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
