import { Router } from "express";
import { sideParam } from "../middleware/side-param.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { listEndpoints, getEndpoint } from "../sophos/api/endpoints.js";

export const endpointsRouter = Router();

endpointsRouter.use("/:side/endpoints", requireConfigured, sideParam);

endpointsRouter.get("/:side/endpoints", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const page = await listEndpoints(ctx.client, ctx.tenantId, {
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 100,
      pageFromKey: typeof req.query.pageFromKey === "string" ? req.query.pageFromKey : undefined,
      hostnameContains:
        typeof req.query.hostnameContains === "string"
          ? req.query.hostnameContains
          : undefined,
      type: req.query.type === "server" ? "server" : req.query.type === "computer" ? "computer" : undefined,
      healthStatus:
        typeof req.query.healthStatus === "string" ? req.query.healthStatus : undefined,
    });
    res.json(page);
  } catch (err) {
    next(err);
  }
});

endpointsRouter.get("/:side/endpoints/:id", async (req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const ep = await getEndpoint(ctx.client, ctx.tenantId, req.params.id!);
    res.json(ep);
  } catch (err) {
    next(err);
  }
});
