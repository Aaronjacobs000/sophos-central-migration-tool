/**
 * Sophos /endpoint/v1/policies wrappers. All functions take an instantiated
 * SophosClient + tenantId and return raw decoded JSON.
 */

import type { SophosClient } from "../client/sophos-client.js";
import type {
  SophosPolicy,
  SophosPolicyPage,
} from "../types/migration.js";

const POLICIES_PATH = "/endpoint/v1/policies";

export async function listPolicies(
  client: SophosClient,
  tenantId: string,
  opts: { policyType?: string; pageSize?: number } = {},
): Promise<SophosPolicy[]> {
  // Walk all pages so the UI can render a consolidated source vs dest list.
  const items: SophosPolicy[] = [];
  let page = 1;
  while (true) {
    const params: Record<string, string> = {
      page: String(page),
      pageSize: String(opts.pageSize ?? 100),
    };
    if (opts.policyType) params.policyType = opts.policyType;

    const res = await client.tenantRequest<SophosPolicyPage>(
      tenantId,
      POLICIES_PATH,
      { params },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}

export async function getPolicy(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosPolicy> {
  return client.tenantRequest<SophosPolicy>(tenantId, `${POLICIES_PATH}/${id}`);
}

export async function createPolicy(
  client: SophosClient,
  tenantId: string,
  body: Partial<SophosPolicy>,
): Promise<SophosPolicy> {
  return client.tenantRequest<SophosPolicy>(tenantId, POLICIES_PATH, {
    method: "POST",
    body,
  });
}

export async function updatePolicy(
  client: SophosClient,
  tenantId: string,
  id: string,
  patch: Partial<SophosPolicy>,
): Promise<SophosPolicy> {
  return client.tenantRequest<SophosPolicy>(tenantId, `${POLICIES_PATH}/${id}`, {
    method: "PATCH",
    body: patch,
  });
}

export async function clonePolicy(
  client: SophosClient,
  tenantId: string,
  sourceId: string,
  newName: string,
): Promise<SophosPolicy> {
  return client.tenantRequest<SophosPolicy>(
    tenantId,
    `${POLICIES_PATH}/${sourceId}/clone`,
    {
      method: "POST",
      body: { name: newName },
    },
  );
}

export async function deletePolicy(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${POLICIES_PATH}/${id}`, {
    method: "DELETE",
  });
}
