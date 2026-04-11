/**
 * Sophos /endpoint/v1/endpoints wrappers (list/get only - mutations are
 * handled via the migration job flow, not direct endpoint edits).
 */

import type { SophosClient } from "../client/sophos-client.js";
import type {
  SophosEndpoint,
  SophosEndpointPage,
} from "../types/sophos.js";

const ENDPOINTS_PATH = "/endpoint/v1/endpoints";

export interface ListEndpointsOptions {
  pageSize?: number;
  /** Cursor-based pagination key from the previous page. */
  pageFromKey?: string;
  /** Optional Sophos-side filters; passed through to query string. */
  hostnameContains?: string;
  ipAddresses?: string;
  type?: "computer" | "server";
  healthStatus?: string;
}

export async function listEndpoints(
  client: SophosClient,
  tenantId: string,
  opts: ListEndpointsOptions = {},
): Promise<SophosEndpointPage> {
  const params: Record<string, string> = {
    pageSize: String(opts.pageSize ?? 100),
  };
  if (opts.pageFromKey) params.pageFromKey = opts.pageFromKey;
  if (opts.hostnameContains) params.hostnameContains = opts.hostnameContains;
  if (opts.ipAddresses) params.ipAddresses = opts.ipAddresses;
  if (opts.type) params.type = opts.type;
  if (opts.healthStatus) params.healthStatus = opts.healthStatus;

  return client.tenantRequest<SophosEndpointPage>(tenantId, ENDPOINTS_PATH, {
    params,
  });
}

/**
 * List ALL endpoints by walking the cursor-based pagination. Use sparingly:
 * tenants with thousands of devices may take a while.
 */
export async function listAllEndpoints(
  client: SophosClient,
  tenantId: string,
  opts: Omit<ListEndpointsOptions, "pageFromKey"> = {},
): Promise<SophosEndpoint[]> {
  const all: SophosEndpoint[] = [];
  let pageFromKey: string | undefined;
  while (true) {
    const page = await listEndpoints(client, tenantId, { ...opts, pageFromKey });
    all.push(...page.items);
    pageFromKey = page.pages?.nextKey;
    if (!pageFromKey) break;
  }
  return all;
}

export async function getEndpoint(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosEndpoint> {
  return client.tenantRequest<SophosEndpoint>(tenantId, `${ENDPOINTS_PATH}/${id}`);
}
