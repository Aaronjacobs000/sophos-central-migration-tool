/**
 * Append-only audit log for every mutation the tool performs against
 * either tenant. Written to data/audit.log as JSON lines.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getState } from "../state.js";

export interface AuditEntry {
  id: string;
  ts: string;
  side: "source" | "dest";
  tenantId: string;
  action: string;
  resource?: string;
  resourceId?: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
  dryRun?: boolean;
}

let writeQueue: Promise<void> = Promise.resolve();

export async function audit(entry: Omit<AuditEntry, "id" | "ts">): Promise<void> {
  const full: AuditEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...entry,
  };

  const state = getState();
  const dir = path.join(state.repoRoot, "data");
  const file = path.join(dir, "audit.log");

  // Serialise writes so concurrent migrations don't interleave lines.
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, JSON.stringify(full) + "\n", { encoding: "utf8" });
  });
  return writeQueue;
}
