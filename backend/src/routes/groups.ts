import { Router } from "express";
import { sideParam } from "../middleware/side-param.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { jsonBody } from "../middleware/json-body.js";
import {
  listGroups,
  getGroup,
  createGroup,
  deleteGroup,
  listGroupMembers,
} from "../sophos/api/groups.js";
import {
  listUserGroups,
  createUserGroup,
  deleteUserGroup,
} from "../sophos/api/user-groups.js";
import { listUsers } from "../sophos/api/users.js";
import { auditedDelete, auditedWrite } from "../services/audit-log.js";

export const groupsRouter = Router();

groupsRouter.use("/:side/groups", requireConfigured, sideParam);
groupsRouter.use("/:side/user-groups", requireConfigured, sideParam);
groupsRouter.use("/:side/users", requireConfigured, sideParam);

groupsRouter.get("/:side/groups", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const items = await listGroups(ctx.client, ctx.tenantId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

groupsRouter.get("/:side/groups/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const group = await getGroup(ctx.client, ctx.tenantId, req.params.id!);
    res.json(group);
  } catch (err) {
    next(err);
  }
});

groupsRouter.get("/:side/groups/:id/members", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const items = await listGroupMembers(ctx.client, ctx.tenantId, req.params.id!);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

groupsRouter.post("/:side/groups", jsonBody, async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const created = await auditedWrite(ctx, "create", "endpoint-group", undefined,
      () => createGroup(ctx.client, ctx.tenantId, req.body), { name: req.body?.name });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

groupsRouter.delete("/:side/groups/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    await auditedDelete(ctx, "endpoint-group", req.params.id!, () => deleteGroup(ctx.client, ctx.tenantId, req.params.id!));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- User groups ---

groupsRouter.get("/:side/user-groups", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const items = await listUserGroups(ctx.client, ctx.tenantId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

groupsRouter.post("/:side/user-groups", jsonBody, async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const created = await auditedWrite(ctx, "create", "user-group", undefined,
      () => createUserGroup(ctx.client, ctx.tenantId, req.body), { name: req.body?.name });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

groupsRouter.delete("/:side/user-groups/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    await auditedDelete(ctx, "user-group", req.params.id!, () => deleteUserGroup(ctx.client, ctx.tenantId, req.params.id!));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Directory users (read-only, used for assignment name resolution) ---

groupsRouter.get("/:side/users", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const items = await listUsers(ctx.client, ctx.tenantId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});
