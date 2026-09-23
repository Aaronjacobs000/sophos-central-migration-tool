// Shared top navigation. Self-bootstrapping: paints synchronously into
// <header id="app-nav"></header> as soon as the module loads, then fetches
// /api/status in the background and updates the status pills when ready.
// This guarantees the nav stays visible even if Sophos API calls hang.

import { api } from "./api.js";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/policies.html", label: "Policies" },
  { href: "/groups.html", label: "Groups" },
  { href: "/exclusions.html", label: "Exclusions" },
  { href: "/endpoints.html", label: "Endpoints" },
  { href: "/migrate-jobs.html", label: "Migrations" },
  { href: "/partner-explorer.html", label: "Partner Explorer", partnerOnly: true },
  { href: "/credentials.html", label: "Credentials" },
  { href: "/logs.html", label: "Logs" },
  { href: "/help.html", label: "Help" },
];

let lastStatus = null;

export function renderNav(status = null) {
  const mount = document.getElementById("app-nav");
  if (!mount) return;
  if (status) lastStatus = status;

  const sourcePill = statusPill("Source", lastStatus?.source);
  const destPill = statusPill("Destination", lastStatus?.dest);

  const currentPath =
    window.location.pathname === "/" ? "/" : window.location.pathname;
  const isPartner = lastStatus?.mode === "partner";
  const navHtml = NAV_ITEMS
    .filter((item) => !item.partnerOnly || isPartner)
    .map((item) => {
      const active = item.href === currentPath ? " active" : "";
      return `<a class="nav-link${active}" href="${item.href}">${item.label}</a>`;
    }).join("");

  mount.innerHTML = `
    <div class="nav-brand">
      <svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="2.5" y="15.5" width="12" height="12" rx="3.5" stroke="currentColor" stroke-width="2.4" opacity="0.55"/><rect x="17.5" y="4.5" width="12" height="12" rx="3.5" fill="currentColor"/><path d="M8.5 12.5V10a4.5 4.5 0 0 1 4.5-4.5h1.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M12.5 2.8l2.6 2.7-2.6 2.7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="brand-title">Tenant Migration</span>
    </div>
    <nav class="nav-links">${navHtml}</nav>
    <div class="nav-status">${sourcePill}${destPill}</div>
  `;
}

function statusPill(label, side) {
  if (!side) {
    return `
      <div class="status-pill">
        <span class="dot"></span>
        <span class="pill-label">${label}</span>
        <span class="pill-detail">…</span>
      </div>
    `;
  }
  let dotClass = "dot-red";
  let detail = "not configured";
  let tooltip = side.error ?? detail;
  if (side.ok) {
    dotClass = "dot-green";
    // Prefer the user label; fall back to a short tenant-ID prefix.
    const display = side.identity?.displayName;
    if (display) {
      detail = display;
    } else {
      const shortId = (side.identity?.tenantId ?? "").slice(0, 8);
      detail = shortId || "connected";
    }
    tooltip = `tenant ${side.identity?.tenantId ?? ""}`.trim();
  } else if (side.configured) {
    dotClass = "dot-amber";
    detail = "error";
  }
  return `
    <div class="status-pill" title="${escapeAttr(tooltip)}">
      <span class="dot ${dotClass}"></span>
      <span class="pill-label">${label}</span>
      <span class="pill-detail">${escapeHtml(detail)}</span>
    </div>
  `;
}

/**
 * Render the shared page footer (legal links + copyright).
 */
export function renderFooter() {
  const mount = document.getElementById("page-footer");
  if (!mount) return;
  mount.innerHTML = `
    <p class="copyright">Unofficial tool, not from Sophos. MIT licence, © 2026 Aaron Jacobs.</p>
  `;
}

/**
 * Auto-bootstrap on import: paint nav + footer placeholders immediately,
 * then fetch /api/status and update the pills. Pages no longer need to
 * call this themselves — but they can pass an explicit status to
 * renderNav() if they already have one.
 */
async function bootNav() {
  renderNav();
  renderFooter();
  try {
    const status = await api.get("/api/status");
    renderNav(status);
    if (status?.status === "unconfigured") {
      const path = window.location.pathname;
      const allowList = ["/welcome.html", "/credentials.html"];
      if (!allowList.includes(path)) {
        window.location.href = "/welcome.html";
      }
    }
  } catch (err) {
    console.error("nav: status check failed", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootNav);
} else {
  bootNav();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
