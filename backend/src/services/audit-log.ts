/**
 * Append-only audit log for every mutation the tool performs against
 * either tenant. Written to data/audit.log as JSON lines.
 *
 * Appends retry while OneDrive or antivirus holds the file (safe-files.ts).
 * An entry that still can't be written never turns a write Sophos made into
 * a failure: it goes to the tool's log, and the response carries a warning
 * (auditOrWarn, auditWarnings).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";
import { getState } from "../state.js";
import { log } from "../log.js";
import { isLock, withRetry } from "./safe-files.js";

const SECTION = "audit";

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
    await withRetry(SECTION, "append audit.log", () => fs.appendFile(file, JSON.stringify(full) + "\n", { encoding: "utf8" }));
  };
  const run = writeQueue.then(write, write);
  writeQueue = run.catch(() => {});
  return run;
}

/** The audit entries a request could not write, for its response's warning. */
interface Unwritten {
  count: number;
  codes: Set<string>;
  locked: boolean;
}

const unwritten = new AsyncLocalStorage<Unwritten>();

/** The response header that says a request's audit entries could not be written. */
export const AUDIT_WARNING_HEADER = "X-Audit-Warning";

/**
 * Audits a write Sophos has already answered. If the entry still can't be
 * written after the lock retries, the write's own result stands: the entry
 * goes to the tool's log, and the request's response carries a warning.
 */
export async function auditOrWarn(entry: Omit<AuditEntry, "id" | "ts">): Promise<void> {
  try {
    await audit(entry);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    const what = [entry.action, entry.resource, entry.resourceId].filter(Boolean).join(" ");
    log.emit(
      "error",
      SECTION,
      `Couldn't write an audit entry to data/audit.log (${code}): ${what} on the ${entry.side} tenant, ${entry.ok ? "done" : "refused"}. The change itself is unaffected; the entry is in this line's detail.`,
      { side: entry.side, detail: { entry, error: err instanceof Error ? err.message : String(err) } },
    );
    const pending = unwritten.getStore();
    if (pending) {
      pending.count++;
      pending.codes.add(code);
      pending.locked ||= isLock(err);
    }
  }
}

function warningText({ count, codes, locked }: Unwritten): string {
  const one = count === 1;
  return (
    `${one ? "The audit entry for this change" : `${count} audit entries for these changes`} couldn't be written to data/audit.log ` +
    `(${[...codes].join(", ")})${locked ? ", usually because OneDrive or antivirus held the file" : ""}. ` +
    `The ${one ? "change itself is" : "changes themselves are"} unaffected; the Logs page has the ${one ? "entry" : "entries"}.`
  );
}

/**
 * Middleware: collects the audit entries a request could not write and, if
 * there are any, adds AUDIT_WARNING_HEADER to its response, which the pages
 * show. Mount it after the body parser, so the routes run inside it.
 */
export function auditWarnings(_req: Request, res: Response, next: NextFunction): void {
  const pending: Unwritten = { count: 0, codes: new Set(), locked: false };
  const writeHead = res.writeHead as (...args: unknown[]) => Response;
  res.writeHead = function (this: Response, ...args: unknown[]) {
    if (pending.count > 0) this.setHeader(AUDIT_WARNING_HEADER, warningText(pending));
    return writeHead.apply(this, args);
  } as typeof res.writeHead;
  unwritten.run(pending, next);
}

/**
 * Runs one write from an API route and audits it, as done or with the error,
 * which is then rethrown for the route's error handler. With no resourceId,
 * the entry takes the ID of what the write returned (a create). An entry that
 * can't be written leaves the write's result as it is (see auditOrWarn).
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
    await auditOrWarn({ ...entry, resourceId, ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  const returnedId = (result as { id?: unknown } | null | undefined)?.id;
  await auditOrWarn({ ...entry, resourceId: resourceId ?? (typeof returnedId === "string" ? returnedId : undefined), ok: true });
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
