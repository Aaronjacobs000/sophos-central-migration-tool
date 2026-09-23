/**
 * Wrappers for Sophos web-control settings: the Website Management
 * local-site list, used to discover which website tags exist in a
 * tenant. Web-control policies reference those tags by name, and writing a
 * policy that names a tag the tenant doesn't have fails outright.
 */

import type { SophosClient } from "../client/sophos-client.js";

const LOCAL_SITES_PATH = "/endpoint/v1/settings/web-control/local-sites";

export interface SophosLocalSite {
  id: string;
  url?: string;
  tags?: string[];
  categoryId?: number;
  comment?: string;
}

export async function listLocalSites(
  client: SophosClient,
  tenantId: string,
): Promise<SophosLocalSite[]> {
  const items: SophosLocalSite[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<{
      items: SophosLocalSite[];
      pages?: { total?: number };
    }>(tenantId, LOCAL_SITES_PATH, {
      params: { page: String(page), pageSize: "100" },
    });
    items.push(...(res.items ?? []));
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}

export async function createLocalSite(
  client: SophosClient,
  tenantId: string,
  body: { url: string; categoryId?: number; tags?: string[]; comment?: string },
): Promise<SophosLocalSite> {
  return client.tenantRequest<SophosLocalSite>(tenantId, LOCAL_SITES_PATH, {
    method: "POST",
    body,
  });
}
