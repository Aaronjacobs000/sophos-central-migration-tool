/**
 * Wrappers for Sophos endpoint settings: scanning exclusions, allowed
 * items (allow list), blocked items (block list).
 */

import type { SophosClient } from "../client/sophos-client.js";
import type {
  SophosScanningExclusion,
  SophosScanningExclusionPage,
  SophosAllowedItem,
  SophosAllowedItemPage,
  SophosBlockedItem,
  SophosBlockedItemPage,
} from "../types/migration.js";

const SCANNING_PATH = "/endpoint/v1/settings/exclusions/scanning";
const ALLOWED_PATH = "/endpoint/v1/settings/allowed-items";
const BLOCKED_PATH = "/endpoint/v1/settings/blocked-items";

async function listAll<T>(
  client: SophosClient,
  tenantId: string,
  path: string,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<{
      items: T[];
      pages?: { total?: number };
    }>(tenantId, path, {
      params: { page: String(page), pageSize: "100" },
    });
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}

export const listScanningExclusions = (c: SophosClient, t: string) =>
  listAll<SophosScanningExclusion>(c, t, SCANNING_PATH);

export const listAllowedItems = (c: SophosClient, t: string) =>
  listAll<SophosAllowedItem>(c, t, ALLOWED_PATH);

export const listBlockedItems = (c: SophosClient, t: string) =>
  listAll<SophosBlockedItem>(c, t, BLOCKED_PATH);

export async function createScanningExclusion(
  client: SophosClient,
  tenantId: string,
  body: Partial<SophosScanningExclusion>,
): Promise<SophosScanningExclusion> {
  return client.tenantRequest<SophosScanningExclusion>(tenantId, SCANNING_PATH, {
    method: "POST",
    body,
  });
}

export async function createAllowedItem(
  client: SophosClient,
  tenantId: string,
  body: Partial<SophosAllowedItem>,
): Promise<SophosAllowedItem> {
  return client.tenantRequest<SophosAllowedItem>(tenantId, ALLOWED_PATH, {
    method: "POST",
    body,
  });
}

export async function createBlockedItem(
  client: SophosClient,
  tenantId: string,
  body: Partial<SophosBlockedItem>,
): Promise<SophosBlockedItem> {
  return client.tenantRequest<SophosBlockedItem>(tenantId, BLOCKED_PATH, {
    method: "POST",
    body,
  });
}

export async function deleteScanningExclusion(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${SCANNING_PATH}/${id}`, {
    method: "DELETE",
  });
}

export async function deleteAllowedItem(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${ALLOWED_PATH}/${id}`, {
    method: "DELETE",
  });
}

export async function deleteBlockedItem(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${BLOCKED_PATH}/${id}`, {
    method: "DELETE",
  });
}
