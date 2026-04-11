import "./nav.js";
import { api } from "./api.js";
import { makeSortable } from "./sortable.js";

async function boot() {
  await load();
}

async function load() {
  try {
    const res = await api.get("/api/migrate/devices/jobs");
    render(res.items || []);
  } catch (err) {
    document.getElementById("jobs-list").innerHTML =
      `<div class="banner banner-err">${escapeHtml(err.message || "Failed to load")}</div>`;
  }
}

function render(jobs) {
  if (jobs.length === 0) {
    document.getElementById("jobs-list").innerHTML =
      `<div class="empty-state">No migration jobs yet. Start one from the <a href="/endpoints.html">Endpoints</a> page.</div>`;
    return;
  }
  const rows = jobs
    .map((j) => {
      const created = new Date(j.createdAt).toLocaleString();
      const statusClass = statusToClass(j.status);
      return `
        <tr>
          <td><a href="/migrate-job-detail.html?id=${encodeURIComponent(j.localJobId)}">${escapeHtml(j.jobName)}</a></td>
          <td><span class="diff-pill ${statusClass}">${escapeHtml(j.status)}</span></td>
          <td>${j.endpointIds.length}</td>
          <td>${escapeHtml(created)}</td>
          <td><code>${escapeHtml(j.sourceMigrationId.slice(0, 8))}…</code></td>
          <td><code>${escapeHtml(j.destMigrationId.slice(0, 8))}…</code></td>
        </tr>
      `;
    })
    .join("");
  const container = document.getElementById("jobs-list");
  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
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
  if (status === "complete") return "diff-pill-add";
  if (status === "failed" || status === "cancelled") return "diff-pill-remove";
  if (status === "partially-complete") return "diff-pill-change";
  return "diff-pill-change";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
