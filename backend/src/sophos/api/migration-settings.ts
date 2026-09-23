/**
 * GET /endpoint/v1/settings/migration: whether this tenant allows device
 * migration, and until when.
 */

import type { SophosClient } from "../client/sophos-client.js";

export interface SophosMigrationSettings {
  enabled?: boolean;
  expiresAt?: string | null;
}

export async function getMigrationSettings(
  client: SophosClient,
  tenantId: string,
): Promise<SophosMigrationSettings> {
  return client.tenantRequest<SophosMigrationSettings>(
    tenantId,
    "/endpoint/v1/settings/migration",
  );
}
