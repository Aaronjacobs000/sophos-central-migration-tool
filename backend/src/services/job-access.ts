/**
 * Which tenants, and which credentials, a migration job is checked with.
 *
 * A job records the tenants it ran against and keeps its own credentials in
 * the encrypted store (job-credentials.ts), so it keeps checking the same
 * tenants whatever the tool is pointed at later. In order:
 *   1. Stored credentials. The tenant IDs they open must match the job's.
 *   2. No stored credentials, but the tool's current connection points at the
 *      job's recorded tenants: the current connection.
 *   3. An older job with no recorded tenants: the current connection, which
 *      the poll trusts only once both tenants return this migration job.
 * Anything else has no way to check the job, and says so.
 */

import {
  createDirectContext,
  createPartnerContext,
  partnerSideContext,
  type PartnerContext,
  type TenantContext,
  type TenantLabel,
} from "../sophos/tenant-context.js";
import { currentContexts, currentCredentials } from "../state.js";
import { getMigrationJob } from "../sophos/api/migrations.js";
import { log, maskSecrets, registerSecret } from "../log.js";
import {
  CredentialUnreadableError,
  getCredential,
  pruneCredentials,
  putCredential,
  type ApiCredential,
} from "./job-credentials.js";
import {
  getJob,
  listJobs,
  updateJob,
  type JobCredentialRefs,
  type JobTenant,
  type LocalMigrationJob,
} from "./migration-store.js";

export interface JobContexts {
  source: TenantContext;
  dest: TenantContext;
  via: "stored" | "current";
  /** Rule 3: the job has no recorded tenants, so the poll must confirm the pair. */
  unverified: boolean;
}

export type AccessProblem = "rejected" | "no-credentials" | "error";

export class JobAccessError extends Error {
  constructor(public readonly problem: AccessProblem, message: string) {
    super(message);
  }
}

/** Sophos refused the credential itself, rather than a request failing. */
export function isRejection(message: string | undefined): boolean {
  if (!message) return false;
  return (
    /Sophos auth (failed|error)/i.test(message) ||
    /Whoami failed \((401|403)\)/.test(message) ||
    /List tenants failed \((401|403)\)/.test(message) ||
    /Sophos API error \(?(401|403)\)?/.test(message) ||
    /not tenant-scoped|Partner mode requires partner/i.test(message) ||
    /not found in this account/i.test(message)
  );
}

export function isNotFound(message: string | undefined): boolean {
  return !!message && /Sophos API error \(?404\)?/.test(message);
}

// ---------- contexts from stored credentials, cached per credential ----------

type Built = { kind: "direct"; ctx: TenantContext } | { kind: "partner"; pctx: PartnerContext };
const cache = new Map<string, Promise<Built>>();

/** One signed-in client per stored credential, shared by every job that uses it. */
function build(entryId: string): Promise<Built> {
  let p = cache.get(entryId);
  if (!p) {
    p = (async (): Promise<Built> => {
      const cred = await getCredential(entryId);
      if (!cred) throw new JobAccessError("no-credentials", "The stored credentials for this job have been removed.");
      if (cred.kind === "partner") return { kind: "partner", pctx: await createPartnerContext(cred) };
      return { kind: "direct", ctx: await createDirectContext("source", cred) };
    })();
    cache.set(entryId, p);
    // A failed build is not kept: the next check tries again.
    p.catch(() => cache.delete(entryId));
  }
  return p;
}

/** Drop cached clients for a job's credentials, so the next check signs in again. */
export function forgetJobContexts(job: Pick<LocalMigrationJob, "credentials">): void {
  if (!job.credentials) return;
  cache.delete(job.credentials.source);
  cache.delete(job.credentials.dest);
}

export function clearJobContextCache(): void {
  cache.clear();
}

async function storedSide(job: LocalMigrationJob, label: TenantLabel): Promise<TenantContext> {
  const refs = job.credentials!;
  const want = job.tenants?.[label];
  const built = await build(label === "source" ? refs.source : refs.dest);
  if (built.kind === "partner") {
    if (!want) throw new JobAccessError("error", "The job has partner credentials but no recorded tenant.");
    if (!built.pctx.tenantResolver.getTenantInfo(want.tenantId)) {
      throw new JobAccessError("rejected", `The stored partner credentials no longer manage ${want.name ?? want.tenantId}.`);
    }
    return partnerSideContext(built.pctx, label, want.tenantId, want.name ?? undefined);
  }
  if (want && built.ctx.tenantId !== want.tenantId) {
    throw new JobAccessError("rejected", `The stored credentials now open a different tenant than ${want.name ?? want.tenantId}.`);
  }
  const ctx = built.ctx;
  return { ...ctx, label, summary: { ...ctx.summary, displayName: want?.name ?? ctx.summary.displayName, userLabel: want?.name ?? null } };
}

export async function contextsForJob(job: LocalMigrationJob): Promise<JobContexts> {
  if (job.credentials) {
    try {
      const [source, dest] = await Promise.all([storedSide(job, "source"), storedSide(job, "dest")]);
      return { source, dest, via: "stored", unverified: false };
    } catch (err) {
      forgetJobContexts(job);
      if (err instanceof JobAccessError) throw err;
      if (err instanceof CredentialUnreadableError) throw new JobAccessError("no-credentials", err.message);
      const message = maskSecrets(err instanceof Error ? err.message : String(err));
      throw new JobAccessError(isRejection(message) ? "rejected" : "error", message);
    }
  }

  const { source, dest } = currentContexts();
  if (job.tenants) {
    if (source && dest && source.tenantId === job.tenants.source.tenantId && dest.tenantId === job.tenants.dest.tenantId) {
      return { source, dest, via: "current", unverified: false };
    }
    throw new JobAccessError("no-credentials", "Credentials are not stored for this job, and the tool now points at other tenants.");
  }
  if (source && dest) return { source, dest, via: "current", unverified: true };
  throw new JobAccessError("no-credentials", "Credentials are not stored for this job.");
}

/**
 * Contexts for a job that is about to be written to (group membership). An
 * older job with no recorded tenants must first be found on both tenants of
 * the current connection, in the right roles.
 */
export async function verifiedContextsForJob(job: LocalMigrationJob): Promise<JobContexts> {
  const ctx = await contextsForJob(job);
  if (!ctx.unverified) return ctx;
  const sendingLabel: TenantLabel = job.direction === "dest-to-source" ? "dest" : "source";
  for (const [label, side, jobId] of [["source", ctx.source, job.sourceMigrationId], ["dest", ctx.dest, job.destMigrationId]] as const) {
    let found: { mode?: string };
    try {
      found = await getMigrationJob(side.client, side.tenantId, jobId);
    } catch (err) {
      const message = maskSecrets(err instanceof Error ? err.message : String(err));
      if (isNotFound(message)) {
        throw new JobAccessError("no-credentials", "This job was not found on the tenants the tool points at now. Attach the credentials it ran with.");
      }
      throw new JobAccessError(isRejection(message) ? "rejected" : "error", message);
    }
    const mode = String(found.mode ?? "").toLowerCase();
    if (mode && mode !== (label === sendingLabel ? "sending" : "receiving")) {
      throw new JobAccessError("no-credentials", "The tool's source and destination are the other way round from when this job ran.");
    }
  }
  return ctx;
}

export function tenantOf(ctx: TenantContext): JobTenant {
  return {
    tenantId: ctx.tenantId,
    name: ctx.summary.displayName ?? ctx.summary.tenantName ?? null,
    apiHost: ctx.summary.apiHost,
    region: ctx.summary.region,
  };
}

// ---------- storing, attaching and removing ----------

/**
 * Entries stored for a job that has not been saved yet. A removal elsewhere
 * prunes entries no saved job refers to, and must not take these meanwhile.
 */
const held = new Map<string, number>();

export function holdCredentials(refs: JobCredentialRefs | null | undefined): void {
  if (!refs) return;
  for (const id of new Set([refs.source, refs.dest])) held.set(id, (held.get(id) ?? 0) + 1);
}

export function releaseCredentials(refs: JobCredentialRefs | null | undefined): void {
  if (!refs) return;
  for (const id of new Set([refs.source, refs.dest])) {
    const n = (held.get(id) ?? 1) - 1;
    if (n > 0) held.set(id, n);
    else held.delete(id);
  }
}

/**
 * Store the tool's current credentials for a new job. Null when none are live.
 * The entries are held until releaseCredentials, once the job is saved.
 */
export async function storeCurrentCredentials(): Promise<JobCredentialRefs | null> {
  const creds = currentCredentials();
  if (!creds) return null;
  const storedAt = new Date().toISOString();
  let refs: JobCredentialRefs;
  if (creds.mode === "partner") {
    const id = await putCredential("partner", creds.partner);
    refs = { mode: "partner", source: id, dest: id, storedAt };
  } else {
    const [source, dest] = await Promise.all([putCredential("tenant", creds.source), putCredential("tenant", creds.dest)]);
    refs = { mode: "direct", source, dest, storedAt };
  }
  holdCredentials(refs);
  return refs;
}

export type AttachInput =
  | { use: "current" }
  | { use: "direct"; sending: ApiCredential; receiving: ApiCredential };

export class AttachError extends Error {}

/**
 * Attach credentials to a job, after checking they open the job's tenants and
 * that both tenants return this migration job (sending and receiving roles in
 * the right places). Read only: the check is two GETs.
 */
export async function attachCredentials(localJobId: string, input: AttachInput): Promise<LocalMigrationJob> {
  const job = await getJob(localJobId);
  if (!job) throw new AttachError("not_found");
  const sendingLabel: TenantLabel = job.direction === "dest-to-source" ? "dest" : "source";

  let source: TenantContext;
  let dest: TenantContext;
  let refs: () => Promise<JobCredentialRefs>;
  if (input.use === "current") {
    const cur = currentContexts();
    const creds = currentCredentials();
    if (!cur.source || !cur.dest || !creds) throw new AttachError("The tool is not connected to two tenants right now.");
    source = cur.source;
    dest = cur.dest;
    refs = async () => (await storeCurrentCredentials())!;
  } else {
    const byLabel = {
      source: sendingLabel === "source" ? input.sending : input.receiving,
      dest: sendingLabel === "source" ? input.receiving : input.sending,
    };
    for (const c of [input.sending, input.receiving]) {
      if (!c?.clientId?.trim() || !c?.clientSecret?.trim()) throw new AttachError("A client ID and client secret are needed for both tenants.");
      registerSecret(c.clientSecret);
    }
    try {
      [source, dest] = await Promise.all([
        createDirectContext("source", { clientId: byLabel.source.clientId.trim(), clientSecret: byLabel.source.clientSecret.trim() }),
        createDirectContext("dest", { clientId: byLabel.dest.clientId.trim(), clientSecret: byLabel.dest.clientSecret.trim() }),
      ]);
    } catch (err) {
      throw new AttachError(`Sophos did not accept these credentials: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
    }
    const names = { source: job.tenants?.source.name ?? null, dest: job.tenants?.dest.name ?? null };
    source = { ...source, summary: { ...source.summary, displayName: names.source, userLabel: names.source } };
    dest = { ...dest, summary: { ...dest.summary, displayName: names.dest, userLabel: names.dest } };
    refs = async () => {
      const [s, d] = await Promise.all([
        putCredential("tenant", { clientId: byLabel.source.clientId.trim(), clientSecret: byLabel.source.clientSecret.trim() }),
        putCredential("tenant", { clientId: byLabel.dest.clientId.trim(), clientSecret: byLabel.dest.clientSecret.trim() }),
      ]);
      const stored: JobCredentialRefs = { mode: "direct", source: s, dest: d, storedAt: new Date().toISOString() };
      holdCredentials(stored);
      return stored;
    };
  }

  for (const [label, ctx] of [["source", source], ["dest", dest]] as const) {
    const want = job.tenants?.[label];
    if (want && want.tenantId !== ctx.tenantId) {
      throw new AttachError(`These credentials open tenant ${ctx.tenantId}, but this job ran on ${want.name ?? want.tenantId} (${want.tenantId}).`);
    }
  }

  for (const [label, ctx, jobId] of [["source", source, job.sourceMigrationId], ["dest", dest, job.destMigrationId]] as const) {
    const role = label === sendingLabel ? "sending" : "receiving";
    const name = ctx.summary.displayName ?? ctx.tenantId;
    let found: { mode?: string; type?: string };
    try {
      found = await getMigrationJob(ctx.client, ctx.tenantId, jobId);
    } catch (err) {
      const message = maskSecrets(err instanceof Error ? err.message : String(err));
      if (isNotFound(message)) throw new AttachError(`Migration job ${jobId} was not found on ${name}. These are not the tenants this job ran on.`);
      throw new AttachError(`Could not read migration job ${jobId} on ${name}: ${message}`);
    }
    const mode = String(found.mode ?? "").toLowerCase();
    if (mode && mode !== role) {
      throw new AttachError(`On ${name} this job is ${mode}, but it should be the ${role} tenant. The source and destination may be the wrong way round.`);
    }
  }

  const stored = await refs();
  forgetJobContexts(job);
  let updated;
  try {
    updated = await updateJob(localJobId, {
      tenants: job.tenants ?? { source: tenantOf(source), dest: tenantOf(dest) },
      credentials: stored,
      monitor: { ...(job.monitor ?? { state: "ok" }), state: "ok", via: "stored", message: undefined },
    });
  } finally {
    releaseCredentials(stored);
  }
  log.emit("info", "migration", `Credentials stored for job ${localJobId} (${stored.mode})`);
  return updated!;
}

/** Remove a job's stored credentials, and any encrypted entry no job still uses. */
export async function removeCredentials(localJobId: string): Promise<LocalMigrationJob | null> {
  const job = await getJob(localJobId);
  if (!job) return null;
  forgetJobContexts(job);
  const updated = await updateJob(localJobId, { credentials: undefined });
  const inUse = new Set<string>(held.keys());
  for (const j of await listJobs()) {
    if (j.credentials) {
      inUse.add(j.credentials.source);
      inUse.add(j.credentials.dest);
    }
  }
  const removed = await pruneCredentials(inUse);
  log.emit("info", "migration", `Stored credentials removed from job ${localJobId}; ${removed} encrypted entr${removed === 1 ? "y" : "ies"} deleted`);
  return updated;
}
