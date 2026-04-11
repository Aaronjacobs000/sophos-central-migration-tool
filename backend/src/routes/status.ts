import { Router } from "express";
import { getStatusPayload } from "../state.js";

export const statusRouter = Router();

statusRouter.get("/status", (_req, res) => {
  res.json(getStatusPayload());
});
