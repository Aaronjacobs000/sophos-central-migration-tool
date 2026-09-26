/**
 * Cloud Security API (/cloud-security/v1, regional host): Linux runtime
 * detection profiles. A server Linux runtime detection policy names its
 * profile by ID and version in endpoint.server-linux-runtime-detection.profile-id
 * and .profile-version. Each tenant numbers a profile's versions from 1.
 */

import type { SophosClient } from "../client/sophos-client.js";
import { listAllPages } from "./paging.js";

const PROFILES_PATH = "/cloud-security/v1/profiles";

export interface SophosRuntimeDetectionProfile {
  id: string;
  name: string;
  /** The profile's latest version. */
  version: number;
  contentVersion?: string;
  policies?: Array<{ id: string; name: string; version: number }>;
}

export const listRuntimeDetectionProfiles = (c: SophosClient, t: string) =>
  listAllPages<SophosRuntimeDetectionProfile>(c, t, PROFILES_PATH);
