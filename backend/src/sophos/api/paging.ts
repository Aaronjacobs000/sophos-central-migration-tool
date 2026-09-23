/**
 * Page-number pagination for list endpoints that return { items, pages }.
 * Asks for pageTotal on the first page so every page is fetched.
 */

import type { SophosClient } from "../client/sophos-client.js";

export async function listAllPages<T>(
  client: SophosClient,
  tenantId: string,
  path: string,
  params: Record<string, string> = {},
  pageSize = 100,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await client.tenantRequest<{ items?: T[]; pages?: { total?: number } }>(
      tenantId,
      path,
      {
        params: {
          ...params,
          page: String(page),
          pageSize: String(pageSize),
          ...(page === 1 ? { pageTotal: "true" } : {}),
        },
      },
    );
    items.push(...(res.items ?? []));
    if (page === 1) totalPages = res.pages?.total ?? 1;
    page++;
  } while (page <= totalPages);
  return items;
}
