/**
 * Sophos /endpoint/v1/migrations wrappers — the actual two-tenant device
 * migration API.
 *
 * Verified against the live API 2026-04-11. Key learnings:
 *   - BOTH receiver and sender requests require `endpoints` (UUID array)
 *     and `fromTenant` (the other tenant's UUID).
 *   - The handshake token is returned in the response as `token`, not
 *     `fromToken`.
 *   - The sender body uses `token` (the value from the receiver response).
 */

import type { SophosClient } from "../client/sophos-client.js";
import type {
  SophosMigrationJob,
  SophosMigrationJobPage,
  SophosMigrationEndpointPage,
} from "../types/migration.js";

const MIGRATIONS_PATH = "/endpoint/v1/migrations";

export async function listMigrationJobs(
  client: SophosClient,
  tenantId: string,
): Promise<SophosMigrationJob[]> {
  const items: SophosMigrationJob[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<SophosMigrationJobPage>(
      tenantId,
      MIGRATIONS_PATH,
      { params: { page: String(page), pageSize: "100" } },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}

export async function getMigrationJob(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosMigrationJob> {
  return client.tenantRequest<SophosMigrationJob>(
    tenantId,
    `${MIGRATIONS_PATH}/${id}`,
  );
}

/** Body for creating a RECEIVER job on the destination tenant. */
export interface CreateReceiverJobBody {
  name: string;
  /** The tenant ID devices are being migrated FROM. */
  fromTenant: string;
  /** The endpoint UUIDs being migrated — required by Sophos on both sides. */
  endpoints: string[];
}

/** Body for creating a SENDER job on the source tenant. */
export interface CreateSenderJobBody {
  name: string;
  /** The tenant ID devices are being migrated TO. */
  fromTenant: string;
  /** The endpoint UUIDs being migrated. */
  endpoints: string[];
  /** The handshake token from the receiver job response (`token` field). */
  token: string;
}

export async function createMigrationJob(
  client: SophosClient,
  tenantId: string,
  body: CreateReceiverJobBody | CreateSenderJobBody,
): Promise<SophosMigrationJob> {
  return client.tenantRequest<SophosMigrationJob>(tenantId, MIGRATIONS_PATH, {
    method: "POST",
    body,
  });
}

export async function deleteMigrationJob(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${MIGRATIONS_PATH}/${id}`, {
    method: "DELETE",
  });
}

export async function listMigrationJobEndpoints(
  client: SophosClient,
  tenantId: string,
  jobId: string,
): Promise<SophosMigrationEndpointPage["items"]> {
  const items: SophosMigrationEndpointPage["items"] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<SophosMigrationEndpointPage>(
      tenantId,
      `${MIGRATIONS_PATH}/${jobId}/endpoints`,
      { params: { page: String(page), pageSize: "100" } },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}
