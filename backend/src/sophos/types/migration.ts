/**
 * Types for the resources the migration tool actually moves around.
 * Kept separate from the vendored sophos.ts file so we can refresh the
 * upstream copy without losing these.
 */

import type { SophosPagedResponse } from "./sophos.js";

// --- Policies ---

export interface SophosPolicy {
  id: string;
  name: string;
  type: string;
  enabled?: boolean;
  priority?: number;
  enforced?: boolean;
  appliesTo?: {
    users?: Array<{ id: string }>;
    userGroups?: Array<{ id: string }>;
    endpoints?: Array<{ id: string }>;
    endpointGroups?: Array<{ id: string }>;
  };
  settings?: Record<string, unknown>;
  lockedByManagingAccount?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type SophosPolicyPage = SophosPagedResponse<SophosPolicy>;

// --- Endpoint groups ---

export interface SophosEndpointGroup {
  id: string;
  name: string;
  description?: string;
  type?: string;
  endpointType?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SophosEndpointGroupPage = SophosPagedResponse<SophosEndpointGroup>;

// --- Exclusions / allow-block lists ---

export interface SophosScanningExclusion {
  id: string;
  type: string;
  value: string;
  scanMode?: string;
  description?: string;
  comment?: string;
  createdAt?: string;
}

export interface SophosAllowedItem {
  id: string;
  type: string;
  /** SHA256 / path / publisher / certificate value */
  properties?: Record<string, unknown>;
  comment?: string;
  origin?: string;
  createdAt?: string;
}

export interface SophosBlockedItem {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  comment?: string;
  origin?: string;
  createdAt?: string;
}

export type SophosScanningExclusionPage = SophosPagedResponse<SophosScanningExclusion>;
export type SophosAllowedItemPage = SophosPagedResponse<SophosAllowedItem>;
export type SophosBlockedItemPage = SophosPagedResponse<SophosBlockedItem>;

// --- Device migrations ---

/** A migration job (sender or receiver) created via /endpoint/v1/migrations. */
export interface SophosMigrationJob {
  id: string;
  status: string;
  type?: "sender" | "receiver" | string;
  mode?: "sending" | "receiving" | string;
  name?: string;
  /** Handshake token returned by Sophos (field name is `token` in the API). */
  token?: string;
  /** Legacy alias — some versions of the MCP repo used this name. */
  fromToken?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt?: string;
  finishedAt?: string;
  endpointCounts?: {
    total?: number;
    successful?: number;
    failed?: number;
    pending?: number;
  };
}

export type SophosMigrationJobPage = SophosPagedResponse<SophosMigrationJob>;

/** Per-endpoint status reported inside a migration job. */
export interface SophosMigrationEndpoint {
  id: string;
  hostname?: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
}

export type SophosMigrationEndpointPage = SophosPagedResponse<SophosMigrationEndpoint>;
