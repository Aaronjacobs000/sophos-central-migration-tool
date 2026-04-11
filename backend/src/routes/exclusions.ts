import { Router } from "express";
import { sideParam } from "../middleware/side-param.js";
import { requireConfigured } from "../middleware/require-configured.js";
import {
  listScanningExclusions,
  listAllowedItems,
  listBlockedItems,
  createScanningExclusion,
  createAllowedItem,
  createBlockedItem,
  deleteScanningExclusion,
  deleteAllowedItem,
  deleteBlockedItem,
} from "../sophos/api/exclusions.js";

export const exclusionsRouter = Router();

exclusionsRouter.use("/:side/exclusions", requireConfigured, sideParam);

exclusionsRouter.get("/:side/exclusions/scanning", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const items = await listScanningExclusions(ctx.client, ctx.tenantId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.get("/:side/exclusions/allowed-items", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const items = await listAllowedItems(ctx.client, ctx.tenantId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.get("/:side/exclusions/blocked-items", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const items = await listBlockedItems(ctx.client, ctx.tenantId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.post("/:side/exclusions/scanning", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const created = await createScanningExclusion(ctx.client, ctx.tenantId, req.body);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.post("/:side/exclusions/allowed-items", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const created = await createAllowedItem(ctx.client, ctx.tenantId, req.body);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.post("/:side/exclusions/blocked-items", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const created = await createBlockedItem(ctx.client, ctx.tenantId, req.body);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.delete("/:side/exclusions/scanning/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    await deleteScanningExclusion(ctx.client, ctx.tenantId, req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.delete("/:side/exclusions/allowed-items/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    await deleteAllowedItem(ctx.client, ctx.tenantId, req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

exclusionsRouter.delete("/:side/exclusions/blocked-items/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    await deleteBlockedItem(ctx.client, ctx.tenantId, req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
