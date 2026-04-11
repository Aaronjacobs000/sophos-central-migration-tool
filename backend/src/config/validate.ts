/**
 * Validates the .env credential shape and provides masking helpers.
 * Supports two credential modes:
 *   "direct"  — two sets of tenant-scoped credentials (source + dest)
 *   "partner" — one set of partner/org credentials + two selected tenant IDs
 */

import type { EnvFile } from "./env-file.js";
import { getEnvValue } from "./env-file.js";

export type CredentialMode = "direct" | "partner";

export const MANAGED_ENV_KEYS = [
  "PORT",
  "CREDENTIAL_MODE",
  // Direct mode
  "SOPHOS_SOURCE_CLIENT_ID",
  "SOPHOS_SOURCE_CLIENT_SECRET",
  "SOPHOS_SOURCE_LABEL",
  "SOPHOS_DEST_CLIENT_ID",
  "SOPHOS_DEST_CLIENT_SECRET",
  "SOPHOS_DEST_LABEL",
  // Partner mode
  "SOPHOS_PARTNER_CLIENT_ID",
  "SOPHOS_PARTNER_CLIENT_SECRET",
  "SOPHOS_PARTNER_LABEL",
  "SOPHOS_PARTNER_SOURCE_TENANT_ID",
  "SOPHOS_PARTNER_SOURCE_LABEL",
  "SOPHOS_PARTNER_DEST_TENANT_ID",
  "SOPHOS_PARTNER_DEST_LABEL",
] as const;

export function getCredentialMode(file: EnvFile): CredentialMode {
  const raw = getEnvValue(file, "CREDENTIAL_MODE")?.trim();
  return raw === "partner" ? "partner" : "direct";
}

// --- Direct mode helpers ---

export interface DirectCredentialView {
  clientId: string;
  clientSecretMasked: string;
  label: string;
  configured: boolean;
}

export function extractDirectCredentials(
  file: EnvFile,
  side: "source" | "dest",
): { clientId: string; clientSecret: string; label: string } | null {
  const prefix = side === "source" ? "SOPHOS_SOURCE_" : "SOPHOS_DEST_";
  const clientId = getEnvValue(file, `${prefix}CLIENT_ID`)?.trim() ?? "";
  const clientSecret = getEnvValue(file, `${prefix}CLIENT_SECRET`)?.trim() ?? "";
  const label = getEnvValue(file, `${prefix}LABEL`)?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, label };
}

export function maskDirectCredentials(
  file: EnvFile,
  side: "source" | "dest",
): DirectCredentialView {
  const creds = extractDirectCredentials(file, side);
  if (!creds) {
    return { clientId: "", clientSecretMasked: "", label: "", configured: false };
  }
  return {
    clientId: creds.clientId,
    clientSecretMasked: maskSecret(creds.clientSecret),
    label: creds.label,
    configured: true,
  };
}

// --- Partner mode helpers ---

export interface PartnerCredentialView {
  clientId: string;
  clientSecretMasked: string;
  label: string;
  configured: boolean;
  sourceTenantId: string;
  sourceLabel: string;
  destTenantId: string;
  destLabel: string;
}

export function extractPartnerCredentials(file: EnvFile): {
  clientId: string;
  clientSecret: string;
  label: string;
  sourceTenantId: string;
  sourceLabel: string;
  destTenantId: string;
  destLabel: string;
} | null {
  const clientId = getEnvValue(file, "SOPHOS_PARTNER_CLIENT_ID")?.trim() ?? "";
  const clientSecret =
    getEnvValue(file, "SOPHOS_PARTNER_CLIENT_SECRET")?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    label: getEnvValue(file, "SOPHOS_PARTNER_LABEL")?.trim() ?? "",
    sourceTenantId:
      getEnvValue(file, "SOPHOS_PARTNER_SOURCE_TENANT_ID")?.trim() ?? "",
    sourceLabel:
      getEnvValue(file, "SOPHOS_PARTNER_SOURCE_LABEL")?.trim() ?? "",
    destTenantId:
      getEnvValue(file, "SOPHOS_PARTNER_DEST_TENANT_ID")?.trim() ?? "",
    destLabel:
      getEnvValue(file, "SOPHOS_PARTNER_DEST_LABEL")?.trim() ?? "",
  };
}

export function maskPartnerCredentials(file: EnvFile): PartnerCredentialView {
  const creds = extractPartnerCredentials(file);
  if (!creds) {
    return {
      clientId: "",
      clientSecretMasked: "",
      label: "",
      configured: false,
      sourceTenantId: "",
      sourceLabel: "",
      destTenantId: "",
      destLabel: "",
    };
  }
  return {
    clientId: creds.clientId,
    clientSecretMasked: maskSecret(creds.clientSecret),
    label: creds.label,
    configured: true,
    sourceTenantId: creds.sourceTenantId,
    sourceLabel: creds.sourceLabel,
    destTenantId: creds.destTenantId,
    destLabel: creds.destLabel,
  };
}

// --- Shared ---

export function maskSecret(secret: string | undefined): string {
  if (!secret) return "";
  if (secret.length <= 4) return "••••";
  return "••••••••" + secret.slice(-4);
}
