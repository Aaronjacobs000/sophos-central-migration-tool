/**
 * Sophos /endpoint/v1/endpoint-groups wrappers.
 */

import type { SophosClient } from "../client/sophos-client.js";
import type { SophosEndpoint, SophosEndpointPage } from "../types/sophos.js";
import type {
  SophosEndpointGroup,
  SophosEndpointGroupPage,
} from "../types/migration.js";

const GROUPS_PATH = "/endpoint/v1/endpoint-groups";

export async function listGroups(
  client: SophosClient,
  tenantId: string,
): Promise<SophosEndpointGroup[]> {
  const items: SophosEndpointGroup[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<SophosEndpointGroupPage>(
      tenantId,
      GROUPS_PATH,
      { params: { page: String(page), pageSize: "100" } },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}

export async function getGroup(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosEndpointGroup> {
  return client.tenantRequest<SophosEndpointGroup>(tenantId, `${GROUPS_PATH}/${id}`);
}

export async function createGroup(
  client: SophosClient,
  tenantId: string,
  body: { name: string; description?: string; type?: string; endpointType?: string },
): Promise<SophosEndpointGroup> {
  return client.tenantRequest<SophosEndpointGroup>(tenantId, GROUPS_PATH, {
    method: "POST",
    body,
  });
}

export async function deleteGroup(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${GROUPS_PATH}/${id}`, {
    method: "DELETE",
  });
}

export async function listGroupMembers(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosEndpoint[]> {
  const items: SophosEndpoint[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<SophosEndpointPage>(
      tenantId,
      `${GROUPS_PATH}/${id}/endpoints`,
      { params: { page: String(page), pageSize: "100" } },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}
