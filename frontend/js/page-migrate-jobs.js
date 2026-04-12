import "./nav.js";
import { api } from "./api.js";
import { makeSortable } from "./sortable.js";

let currentTab = "all";

async function boot() {
  // Wire up tab buttons
  for (const btn of document.querySelectorAll("#jobs-tabs .tab-btn")) {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      for (const b of document.querySelectorAll("#jobs-tabs .tab-btn")) {
        b.classList.toggle("active", b === btn);
      }
      load();
    });
  }
  await load();
}

async function load() {
  const container = document.getElementById("jobs-list");
  container.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const endpoint = currentTab === "all"
      ? "/api/migrate/devices/jobs/all"
      : "/api/migrate/devices/jobs";
    const res = await api.get(endpoint);
    render(res.items || []);
  } catch (err) {
    container.innerHTML =
      `<div class="banner banner-err">${escapeHtml(err.message || "Failed to load")}</div>`;
  }
}

function render(jobs) {
  const container = document.getElementById("jobs-list");
  if (jobs.length === 0) {
    container.innerHTML =
      `<div class="empty-state">No migration jobs found. Start one from the <a href="/endpoints.html">Endpoints</a> page.</div>`;
    return;
  }

  const rows = jobs
    .map((j) => {
      const created = j.createdAt ? new Date(j.createdAt).toLocaleString() : "—";
      const statusClass = statusToClass(j.status);
      const isLocal = j.origin === "local";

      // Origin badge
      const originBadge = isLocal
        ? `<span class="origin-pill origin-local">This tool</span>`
        : `<span class="origin-pill origin-api">API</span>`;

      // Name column — link to detail if we have a local ID
      const nameCell = j.localJobId
        ? `<a href="/migrate-job-detail.html?id=${encodeURIComponent(j.localJobId)}">${escapeHtml(j.jobName)}</a>`
        : escapeHtml(j.jobName);

      // Endpoints count
      const epCount = j.endpointCount != null ? j.endpointCount : "—";

      // Migration IDs
      const sourceId = j.sourceMigrationId
        ? `<code>${escapeHtml(j.sourceMigrationId.slice(0, 8))}…</code>`
        : "—";
      const destId = j.destMigrationId
        ? `<code>${escapeHtml(j.destMigrationId.slice(0, 8))}…</code>`
        : "—";

      // For API-only jobs, show the single migration ID + mode + tenant
      const apiInfo = !isLocal
        ? `<code>${escapeHtml((j.apiMigrationId || "").slice(0, 8))}…</code>
           <span class="text-muted">${escapeHtml(j.apiJobMode || "")} on ${escapeHtml(j.apiTenant || "")}</span>`
        : "";

      return `
        <tr>
          <td>${nameCell}</td>
          <td>${originBadge}</td>
          <td><span class="diff-pill ${statusClass}">${escapeHtml(j.status)}</span></td>
          <td>${epCount}</td>
          <td>${created}</td>
          <td>${isLocal ? sourceId : apiInfo || sourceId}</td>
          <td>${isLocal ? destId : "—"}</td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Origin</th>
          <th>Status</th>
          <th>Endpoints</th>
          <th>Created</th>
          <th>Source job</th>
          <th>Dest job</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  makeSortable(container);
}

function statusToClass(status) {
  const s = (status || "").toLowerCase();
  if (s === "complete" || s === "completed" || s === "succeeded") return "diff-pill-add";
  if (s === "failed" || s === "cancelled" || s === "error") return "diff-pill-remove";
  return "diff-pill-change";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
