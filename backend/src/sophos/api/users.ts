/**
 * Sophos /common/v1/directory/users wrappers. Read-only — used to resolve
 * user IDs to human-readable names when exporting policy assignments.
 */

import type { SophosClient } from "../client/sophos-client.js";
import type { SophosPagedResponse } from "../types/sophos.js";

export interface SophosUser {
  id: string;
  name?: string;
  email?: string;
  source?: string; // e.g. "custom", "activeDirectory"
  createdAt?: string;
  updatedAt?: string;
}

const USERS_PATH = "/common/v1/directory/users";

export async function listUsers(
  client: SophosClient,
  tenantId: string,
): Promise<SophosUser[]> {
  const items: SophosUser[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<SophosPagedResponse<SophosUser>>(
      tenantId,
      USERS_PATH,
      { params: { page: String(page), pageSize: "100" } },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}
