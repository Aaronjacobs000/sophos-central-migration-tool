/**
 * GET /licenses/v1/licenses on the global host. The Licensing API is scoped
 * by an explicit X-Tenant-ID header, so it works for tenant, partner and
 * organization credentials alike.
 */

import type { SophosClient } from "../client/sophos-client.js";

export interface SophosLicense {
  id?: string;
  licenseIdentifier?: string;
  product?: { code?: string; name?: string; genericCode?: string };
  startDate?: string;
  endDate?: string;
  perpetual?: boolean;
  type?: string;
  quantity?: number | null;
  unlimited?: boolean;
  usage?: { current?: { count?: number; date?: string; collectedAt?: string } };
}

export interface SophosLicenseList {
  licenses?: SophosLicense[];
}

export async function listLicenses(
  client: SophosClient,
  tenantId: string,
): Promise<SophosLicense[]> {
  const res = await client.globalRequest<SophosLicenseList>("/licenses/v1/licenses", {
    headers: { "X-Tenant-ID": tenantId },
  });
  return res.licenses ?? [];
}
