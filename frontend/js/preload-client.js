// Helper for fetching cached preload data and triggering refresh.
// Pages prefer this over hitting the live Sophos APIs because the preloader
// has already done the work after credentials were saved.

import { api } from "./api.js";

export async function getCachedSection(side, section) {
  const res = await api.get(
    `/api/preload/data/${encodeURIComponent(section)}/${encodeURIComponent(side)}`,
  );
  return res; // { status, items }
}

export async function refreshSection(side, section) {
  return api.post(
    `/api/preload/refresh/${encodeURIComponent(section)}/${encodeURIComponent(side)}`,
  );
}

export async function getPreloadStatus() {
  return api.get("/api/preload/status");
}

export async function startPreload() {
  return api.post("/api/preload/start");
}
