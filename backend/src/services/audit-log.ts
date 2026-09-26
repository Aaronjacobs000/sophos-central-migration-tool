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

  // Serialise writes so concurrent migrations don't interleave lines. A write
  // that fails fails alone: the next one still runs.
  const write = async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, JSON.stringify(full) + "\n", { encoding: "utf8" });
  };
  const run = writeQueue.then(write, write);
  writeQueue = run.catch(() => {});
  return run;
}

/**
 * Runs one write from an API route and audits it, as done or with the error,
 * which is then rethrown for the route's error handler. With no resourceId,
 * the entry takes the ID of what the write returned (a create).
 */
export async function auditedWrite<T>(
  ctx: { label: "source" | "dest"; tenantId: string },
  action: string,
  resource: string,
  resourceId: string | undefined,
  run: () => Promise<T>,
  detail?: unknown,
): Promise<T> {
  const entry = { side: ctx.label, tenantId: ctx.tenantId, action, resource, ...(detail === undefined ? {} : { detail }) };
  let result: T;
  try {
    result = await run();
  } catch (err) {
    await audit({ ...entry, resourceId, ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  const returnedId = (result as { id?: unknown } | null | undefined)?.id;
  await audit({ ...entry, resourceId: resourceId ?? (typeof returnedId === "string" ? returnedId : undefined), ok: true });
  return result;
}

/** Runs one delete from a page's row menu and audits it (see auditedWrite). */
export async function auditedDelete(
  ctx: { label: "source" | "dest"; tenantId: string },
  resource: string,
  resourceId: string,
  run: () => Promise<unknown>,
): Promise<void> {
  await auditedWrite(ctx, "delete", resource, resourceId, run);
}
