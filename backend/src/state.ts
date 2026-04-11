/**
 * In-memory singleton that tracks the server's configuration state and
 * holds the live tenant contexts (source + dest) plus, in partner mode,
 * the shared PartnerContext with its list of all managed tenants.
 *
 * Rebuilt on startup and after any credentials write.
 */

import path from "node:path";
import {
  applyEnvToProcess,
  readEnvFile,
  writeEnvFile,
  setEnvValues,
  type EnvFile,
} from "./config/env-file.js";
import {
  MANAGED_ENV_KEYS,
  getCredentialMode,
  extractDirectCredentials,
  extractPartnerCredentials,
  maskDirectCredentials,
  maskPartnerCredentials,
  type CredentialMode,
  type DirectCredentialView,
  type PartnerCredentialView,
} from "./config/validate.js";
import {
  createDirectContext,
  createPartnerContext,
  partnerSideContext,
  type TenantContext,
  type PartnerContext,
  type TenantLabel,
} from "./sophos/tenant-context.js";
import type { TenantInfo } from "./sophos/client/tenant-resolver.js";
import { log } from "./log.js";
import { startPreload, resetPreloadCache } from "./services/preloader.js";
import { clearDeepMatchCache } from "./routes/compare.js";

export type AppStatus =
  | "unconfigured"
  | "configured-invalid"
  | "configured-ok";

export interface SideStatus {
  configured: boolean;
  ok: boolean;
  error?: string;
  identity?: TenantContext["summary"];
}

export interface StatusPayload {
  status: AppStatus;
  mode: CredentialMode;
  source: SideStatus;
  dest: SideStatus;
  /** In partner mode, the total number of managed tenants loaded. */
  partnerTenantCount?: number;
}

export interface AppState {
  repoRoot: string;
  envPath: string;
  status: AppStatus;
  mode: CredentialMode;
  source: TenantContext | null;
  dest: TenantContext | null;
  /** Only set in partner mode. */
  partner: PartnerContext | null;
  lastError: { source?: string; dest?: string; partner?: string };
  envFile: EnvFile;
}

let state: AppState | null = null;

export function getState(): AppState {
  if (!state) throw new Error("State not initialised. Call initState() first.");
  return state;
}

export async function initState(repoRoot: string): Promise<AppState> {
  const envPath = path.join(repoRoot, ".env");
  const envFile = await readEnvFile(envPath);
  applyEnvToProcess(envFile, MANAGED_ENV_KEYS as unknown as string[]);

  state = {
    repoRoot,
    envPath,
    status: "unconfigured",
    mode: "direct",
    source: null,
    dest: null,
    partner: null,
    lastError: {},
    envFile,
  };

  await rebuildContexts();
  return state;
}

/**
 * Re-reads the .env file, attempts to instantiate each tenant context,
 * and updates the state status accordingly.
 */
export async function rebuildContexts(): Promise<void> {
  if (!state) throw new Error("State not initialised");

  state.envFile = await readEnvFile(state.envPath);
  applyEnvToProcess(state.envFile, MANAGED_ENV_KEYS as unknown as string[]);

  state.source = null;
  state.dest = null;
  state.partner = null;
  state.lastError = {};
  clearDeepMatchCache();

  const mode = getCredentialMode(state.envFile);
  state.mode = mode;

  if (mode === "partner") {
    await rebuildPartnerContexts();
  } else {
    await rebuildDirectContexts();
  }

  const st = state as AppState;
  if (st.source && st.dest) {
    st.status = "configured-ok";
    log.info(
      `[state] configured-ok mode=${mode} source=${st.source.tenantId} dest=${st.dest.tenantId}`,
    );
    startPreload();
  } else if (st.lastError.source || st.lastError.dest || st.lastError.partner) {
    st.status = "configured-invalid";
    log.warn(
      `[state] configured-invalid mode=${mode} source=${st.lastError.source ?? "ok"} dest=${st.lastError.dest ?? "ok"} partner=${st.lastError.partner ?? "ok"}`,
    );
    resetPreloadCache();
  } else {
    st.status = "unconfigured";
    log.info(`[state] unconfigured mode=${mode}`);
    resetPreloadCache();
  }
}

async function rebuildDirectContexts(): Promise<void> {
  if (!state) return;
  const sourceCreds = extractDirectCredentials(state.envFile, "source");
  const destCreds = extractDirectCredentials(state.envFile, "dest");
  if (!sourceCreds || !destCreds) return;

  const [sr, dr] = await Promise.allSettled([
    createDirectContext("source", sourceCreds),
    createDirectContext("dest", destCreds),
  ]);
  if (sr.status === "fulfilled") state.source = sr.value;
  else state.lastError.source = errMsg(sr.reason);
  if (dr.status === "fulfilled") state.dest = dr.value;
  else state.lastError.dest = errMsg(dr.reason);
}

async function rebuildPartnerContexts(): Promise<void> {
  if (!state) return;
  const pCreds = extractPartnerCredentials(state.envFile);
  if (!pCreds) return;

  try {
    const pctx = await createPartnerContext({
      clientId: pCreds.clientId,
      clientSecret: pCreds.clientSecret,
      label: pCreds.label,
    });
    state.partner = pctx;
  } catch (err) {
    state.lastError.partner = errMsg(err);
    return;
  }

  // Build side contexts if tenant IDs are selected
  if (pCreds.sourceTenantId) {
    try {
      state.source = partnerSideContext(
        state.partner,
        "source",
        pCreds.sourceTenantId,
        pCreds.sourceLabel,
      );
    } catch (err) {
      state.lastError.source = errMsg(err);
    }
  }
  if (pCreds.destTenantId) {
    try {
      state.dest = partnerSideContext(
        state.partner,
        "dest",
        pCreds.destTenantId,
        pCreds.destLabel,
      );
    } catch (err) {
      state.lastError.dest = errMsg(err);
    }
  }
}

// --- Credential persistence ---

export async function saveDirectCredentials(updates: {
  source?: { clientId?: string; clientSecret?: string; label?: string };
  dest?: { clientId?: string; clientSecret?: string; label?: string };
}): Promise<void> {
  if (!state) throw new Error("State not initialised");
  const current = await readEnvFile(state.envPath);
  let next = setEnvValues(current, { CREDENTIAL_MODE: "direct" });
  if (updates.source) {
    next = setEnvValues(next, {
      SOPHOS_SOURCE_CLIENT_ID: updates.source.clientId,
      SOPHOS_SOURCE_CLIENT_SECRET: updates.source.clientSecret,
      SOPHOS_SOURCE_LABEL: updates.source.label,
    });
  }
  if (updates.dest) {
    next = setEnvValues(next, {
      SOPHOS_DEST_CLIENT_ID: updates.dest.clientId,
      SOPHOS_DEST_CLIENT_SECRET: updates.dest.clientSecret,
      SOPHOS_DEST_LABEL: updates.dest.label,
    });
  }
  await writeEnvFile(next);
  await rebuildContexts();
}

export async function savePartnerCredentials(updates: {
  clientId?: string;
  clientSecret?: string;
  label?: string;
  sourceTenantId?: string;
  sourceLabel?: string;
  destTenantId?: string;
  destLabel?: string;
}): Promise<void> {
  if (!state) throw new Error("State not initialised");
  const current = await readEnvFile(state.envPath);
  let next = setEnvValues(current, { CREDENTIAL_MODE: "partner" });
  next = setEnvValues(next, {
    SOPHOS_PARTNER_CLIENT_ID: updates.clientId,
    SOPHOS_PARTNER_CLIENT_SECRET: updates.clientSecret,
    SOPHOS_PARTNER_LABEL: updates.label,
    SOPHOS_PARTNER_SOURCE_TENANT_ID: updates.sourceTenantId,
    SOPHOS_PARTNER_SOURCE_LABEL: updates.sourceLabel,
    SOPHOS_PARTNER_DEST_TENANT_ID: updates.destTenantId,
    SOPHOS_PARTNER_DEST_LABEL: updates.destLabel,
  });
  await writeEnvFile(next);
  await rebuildContexts();
}

// --- Public status accessors ---

export function getStatusPayload(): StatusPayload {
  if (!state) throw new Error("State not initialised");
  const sourceCreds =
    state.mode === "direct"
      ? extractDirectCredentials(state.envFile, "source")
      : extractPartnerCredentials(state.envFile);
  const destCreds =
    state.mode === "direct"
      ? extractDirectCredentials(state.envFile, "dest")
      : extractPartnerCredentials(state.envFile);

  const source: SideStatus = {
    configured: sourceCreds !== null,
    ok: state.source !== null,
    error: state.lastError.source,
    identity: state.source?.summary,
  };
  const dest: SideStatus = {
    configured: destCreds !== null,
    ok: state.dest !== null,
    error: state.lastError.dest,
    identity: state.dest?.summary,
  };
  const payload: StatusPayload = {
    status: state.status,
    mode: state.mode,
    source,
    dest,
  };
  if (state.mode === "partner" && state.partner) {
    payload.partnerTenantCount = state.partner.tenants.length;
  }
  return payload;
}

export function getCredentialsView(): {
  mode: CredentialMode;
  direct: { source: DirectCredentialView; dest: DirectCredentialView };
  partner: PartnerCredentialView;
} {
  if (!state) throw new Error("State not initialised");
  return {
    mode: state.mode,
    direct: {
      source: maskDirectCredentials(state.envFile, "source"),
      dest: maskDirectCredentials(state.envFile, "dest"),
    },
    partner: maskPartnerCredentials(state.envFile),
  };
}

export function getPartnerTenants(): TenantInfo[] {
  if (!state?.partner) return [];
  return state.partner.tenants;
}

export function requireContext(label: TenantLabel): TenantContext {
  if (!state) throw new Error("State not initialised");
  const ctx = label === "source" ? state.source : state.dest;
  if (!ctx) {
    throw new Error(
      `${label} tenant is not configured. Complete setup first.`,
    );
  }
  return ctx;
}

export function getPartnerContext(): PartnerContext | null {
  return state?.partner ?? null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
