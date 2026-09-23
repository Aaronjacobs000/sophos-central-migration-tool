/**
 * Vendored from sophos-central-mcp @ 1b10f6d3aa3f2d5ed3dce70533688b2a0f4dbe4d
 * Upstream: https://github.com/Aaronjacobs000/sophos-mcp/blob/main/src/types/sophos.ts
 * License: MIT
 *
 * TypeScript type definitions for Sophos Central API responses.
 */

// --- Auth ---

export interface SophosTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  errorCode?: string;
  message?: string;
}

// --- Whoami ---

export interface SophosWhoamiResponse {
  id: string;
  idType: string;
  apiHosts: {
    global: string;
    dataRegion?: string;
  };
}

// --- Endpoints ---

export interface SophosEndpoint {
  id: string;
  type: string;
  tenant: { id: string };
  hostname: string;
  health: {
    overall: string;
    threats: { status: string };
    services: {
      status: string;
      serviceDetails?: Array<{
        name: string;
        status: string;
      }>;
    };
  };
  os: {
    isServer: boolean;
    platform: string;
    name: string;
    majorVersion: number;
    minorVersion: number;
    build?: number;
  };
  ipv4Addresses?: string[];
  ipv6Addresses?: string[];
  macAddresses?: string[];
  associatedPerson?: {
    name?: string;
    viaLogin?: string;
    id?: string;
  };
  tamperProtectionEnabled: boolean;
  assignedProducts?: Array<{
    code: string;
    version: string;
    status: string;
  }>;
  lastSeenAt?: string;
  groupId?: string;
  groupName?: string;
  lockdown?: {
    status: string;
  };
  isolation?: {
    status: string;
  };
}

export interface SophosEndpointPage {
  pages: {
    fromKey?: string;
    nextKey?: string;
    size: number;
    maxSize: number;
    total?: number;
    current?: number;
    items?: number;
  };
  items: SophosEndpoint[];
}

// --- Generic Error ---

export interface SophosApiError {
  error: string;
  message: string;
  correlationId?: string;
  code?: string;
  createdAt?: string;
  requestId?: string;
  docUrl?: string;
}

// --- Generic paginated response wrapper ---

export interface SophosPagedResponse<T> {
  pages: {
    current?: number;
    size: number;
    total?: number;
    maxSize: number;
    items?: number;
    fromKey?: string;
    nextKey?: string;
  };
  items: T[];
}
