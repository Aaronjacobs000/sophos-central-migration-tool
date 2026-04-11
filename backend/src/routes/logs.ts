/**
 * Exposes the in-memory log ring buffer to the UI so the user can spot
 * problems without tailing the console.
 */

import { Router } from "express";
import { getRingBuffer, clearRingBuffer } from "../log.js";

export const logsRouter = Router();

logsRouter.get("/logs", (req, res) => {
  let entries = getRingBuffer();
  const section = typeof req.query.section === "string" ? req.query.section : null;
  const side = typeof req.query.side === "string" ? req.query.side : null;
  const level = typeof req.query.level === "string" ? req.query.level : null;
  const since = typeof req.query.since === "string" ? req.query.since : null;

  if (section) entries = entries.filter((e) => e.section === section);
  if (side) entries = entries.filter((e) => e.side === side);
  if (level) entries = entries.filter((e) => e.level === level);
  if (since) entries = entries.filter((e) => e.ts > since);

  res.json({ items: entries });
});

logsRouter.delete("/logs", (_req, res) => {
  clearRingBuffer();
  res.json({ ok: true });
});
