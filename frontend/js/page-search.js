import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { makeSortable } from "./sortable.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

async function boot() {
  // Check mode to show/hide the "all tenants" scope option
  try {
    const status = await api.get("/api/status");
    if (status.mode !== "partner") {
      document.getElementById("scope-select").querySelector('[value="all"]').disabled = true;
    }
  } catch {}

  document.getElementById("search-btn").addEventListener("click", doSearch);
  document.getElementById("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
}

async function doSearch() {
  const q = document.getElementById("search-input").value.trim();
  const scope = document.getElementById("scope-select").value;
  const results = document.getElementById("results");
  if (!q) {
    toast("Enter a hostname to search.", "info");
    return;
  }
  results.innerHTML = `<div class="empty-state">Searching for "${esc(q)}"…</div>`;
  try {
    const res = await api.get(`/api/search/endpoints?q=${encodeURIComponent(q)}&scope=${scope}`);
    renderResults(res.items || [], q, scope);
  } catch (err) {
    results.innerHTML = `<div class="banner banner-err">${esc(err.message || "Search failed")}</div>`;
  }
}

function renderResults(items, q, scope) {
  const results = document.getElementById("results");
  if (items.length === 0) {
    results.innerHTML = `<div class="empty-state">No endpoints matching "${esc(q)}" found${scope === "all" ? " across any tenant" : " in source or destination"}.</div>`;
    return;
  }

  const rows = items.map((r) => {
    const ep = r.endpoint;
    const stale = isStale(ep);
    const staleBadge = stale ? `<span class="diff-pill diff-pill-remove" style="margin-left:0.4rem;">stale</span>` : "";
    const sideBadge = sideLabel(r.side);
    const lastSeen = ep.lastSeenAt ? new Date(ep.lastSeenAt).toLocaleDateString() : "—";
    const os = ep.os ? `${ep.os.name || ep.os.platform || ""} ${ep.os.majorVersion ?? ""}`.trim() : "";
    const ips = (ep.ipv4Addresses || []).join(", ") || "—";
    const person = ep.associatedPerson?.name || ep.associatedPerson?.viaLogin || "—";
    const health = ep.health?.overall || "—";
    const products = (ep.assignedProducts || []).map((p) => `${p.code} ${p.version}`).join(", ") || "—";

    return `
      <tr>
        <td><strong>${esc(ep.hostname || "")}</strong>${staleBadge}</td>
        <td>${sideBadge}</td>
        <td><code>${esc(r.tenantName || r.tenantId.slice(0, 8))}</code></td>
        <td>${esc(os)}</td>
        <td>${esc(health)}</td>
        <td>${esc(ips)}</td>
        <td>${esc(person)}</td>
        <td>${lastSeen}</td>
        <td class="col-actions">
          <button class="btn btn-small" data-detail='${escAttr(JSON.stringify(ep))}'>Detail</button>
        </td>
      </tr>`;
  }).join("");

  results.innerHTML = `
    <p class="hint" style="margin-bottom:0.75rem;">${items.length} result${items.length === 1 ? "" : "s"} for "${esc(q)}"</p>
    <table class="data-table">
      <thead>
        <tr>
          <th>Hostname</th>
          <th>Side</th>
          <th>Tenant</th>
          <th>OS</th>
          <th>Health</th>
          <th>IP</th>
          <th>User</th>
          <th>Last seen</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  makeSortable(results);

  results.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const ep = JSON.parse(e.target.dataset.detail);
      showDetailModal(ep);
    });
  });
}

function sideLabel(side) {
  if (side === "source") return `<span class="diff-pill" style="background:rgba(54,145,227,0.14);color:#8fc3f1;border:1px solid rgba(54,145,227,0.35);">source</span>`;
  if (side === "dest") return `<span class="diff-pill" style="background:rgba(177,102,220,0.14);color:#d6a8f0;border:1px solid rgba(177,102,220,0.35);">dest</span>`;
  return `<span class="diff-pill" style="background:var(--bg-surface-3);color:var(--text-muted);">other</span>`;
}

function showDetailModal(ep) {
  let existing = document.getElementById("detail-modal");
  if (existing) existing.remove();

  const products = (ep.assignedProducts || []).map((p) =>
    `<li><code>${esc(p.code)}</code> v${esc(p.version)} — ${esc(p.status)}</li>`
  ).join("") || "<li>—</li>";

  const services = (ep.health?.services?.serviceDetails || []).map((s) =>
    `<li>${esc(s.name)}: ${esc(s.status)}</li>`
  ).join("") || "<li>—</li>";

  const modal = document.createElement("div");
  modal.id = "detail-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-card">
      <header class="modal-header">
        <h2>${esc(ep.hostname)}</h2>
        <button class="btn btn-small modal-close">Close</button>
      </header>
      <div class="modal-body">
        <dl class="kv-list">
          <dt>ID</dt><dd><code>${esc(ep.id)}</code></dd>
          <dt>Type</dt><dd>${esc(ep.type || "")}</dd>
          <dt>OS</dt><dd>${esc(ep.os?.name || "")} ${esc(String(ep.os?.majorVersion ?? ""))}.${esc(String(ep.os?.minorVersion ?? ""))} (${esc(ep.os?.platform || "")})</dd>
          <dt>Is server</dt><dd>${ep.os?.isServer ? "yes" : "no"}</dd>
          <dt>Health</dt><dd>${esc(ep.health?.overall || "")}</dd>
          <dt>Threats</dt><dd>${esc(ep.health?.threats?.status || "")}</dd>
          <dt>Services</dt><dd>${esc(ep.health?.services?.status || "")}</dd>
          <dt>IPv4</dt><dd>${esc((ep.ipv4Addresses || []).join(", ") || "—")}</dd>
          <dt>IPv6</dt><dd>${esc((ep.ipv6Addresses || []).join(", ") || "—")}</dd>
          <dt>MAC</dt><dd>${esc((ep.macAddresses || []).join(", ") || "—")}</dd>
          <dt>User</dt><dd>${esc(ep.associatedPerson?.name || "")} ${esc(ep.associatedPerson?.viaLogin ? `(${ep.associatedPerson.viaLogin})` : "")}</dd>
          <dt>Tamper protection</dt><dd>${ep.tamperProtectionEnabled ? "enabled" : "disabled"}</dd>
          <dt>Isolation</dt><dd>${esc(ep.isolation?.status || "—")}</dd>
          <dt>Lockdown</dt><dd>${esc(ep.lockdown?.status || "—")}</dd>
          <dt>Group</dt><dd>${esc(ep.groupName || "—")} ${ep.groupId ? `<code>${esc(ep.groupId)}</code>` : ""}</dd>
          <dt>Last seen</dt><dd>${ep.lastSeenAt ? new Date(ep.lastSeenAt).toLocaleString() : "—"}</dd>
        </dl>
        <h3 style="margin-top:1rem;">Assigned products</h3>
        <ul>${products}</ul>
        <h3 style="margin-top:1rem;">Service details</h3>
        <ul>${services}</ul>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".modal-close").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

function isStale(ep) {
  if (!ep.lastSeenAt) return true;
  return Date.now() - new Date(ep.lastSeenAt).getTime() > FOURTEEN_DAYS_MS;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

boot();
