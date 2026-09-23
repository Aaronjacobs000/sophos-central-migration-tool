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
  container.innerHTML = `<div class="empty-state">Loading</div>`;
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
      `<div class="empty-state">No migration jobs yet. Start one from the <a href="/endpoints.html">Endpoints</a> page.</div>`;
    return;
  }

  const rows = jobs
    .map((j) => {
      const created = j.createdAt ? new Date(j.createdAt).toLocaleString() : "unknown";
      const isLocal = j.origin === "local";

      const originBadge = isLocal
        ? `<span class="tag tag-src">This tool</span>`
        : `<span class="tag tag-dst" title="Found on the ${escapeHtml(j.apiTenant === "dest" ? "destination" : "source")} tenant">Other</span>`;

      const nameCell = j.localJobId
        ? `<a href="/migrate-job-detail.html?id=${encodeURIComponent(j.localJobId)}">${escapeHtml(j.jobName)}</a>`
        : `<span class="cell-name">${escapeHtml(j.jobName)}</span>`;

      const epCount = j.endpointCount != null ? j.endpointCount : "-";

      const sourceId = j.sourceMigrationId
        ? `<code>${escapeHtml(j.sourceMigrationId.slice(0, 8))}</code>`
        : "-";
      const destId = j.destMigrationId
        ? `<code>${escapeHtml(j.destMigrationId.slice(0, 8))}</code>`
        : "-";

      const apiInfo = !isLocal
        ? `<code>${escapeHtml((j.apiMigrationId || "").slice(0, 8))}</code>
           <span class="hint">${escapeHtml(j.apiJobMode || "")} on ${escapeHtml(j.apiTenant === "dest" ? "destination" : j.apiTenant || "")}</span>`
        : "";

      return `
        <tr>
          <td>${nameCell}</td>
          <td>${originBadge}</td>
          <td>${statusTag(j.status)}</td>
          <td class="job-progress"><div class="job-progress-inner">${progressCell(j)}</div></td>
          <td class="tnum">${epCount}</td>
          <td class="cell-nowrap"><span class="hint">${created}</span></td>
          <td>${isLocal ? sourceId : apiInfo || sourceId}</td>
          <td>${isLocal ? destId : "-"}</td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <table class="data-table jobs-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Origin</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Devices</th>
          <th>Created</th>
          <th>Source job</th>
          <th>Destination job</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  makeSortable(container);
}

// Share of devices that reached a final state (moved or failed).
function progressCell(j) {
  const s = (j.status || "").toLowerCase();
  const details = new Map();
  for (const e of [...(j.sourceSnapshot?.endpointDetails ?? []), ...(j.destSnapshot?.endpointDetails ?? [])]) {
    const prev = details.get(e.id);
    if (!prev || isFinal(e.status)) details.set(e.id, e);
  }
  const total = j.endpointCount || details.size;
  let done = [...details.values()].filter((e) => isFinal(e.status)).length;
  let known = details.size > 0 && total > 0;
  if (!known && ["complete", "completed", "succeeded", "failed", "partially-complete", "cancelled"].includes(s)) {
    done = total || 1;
    known = true;
  }
  if (!known) {
    return `<div class="bar"><span class="bar-fill is-live" style="width:35%"></span></div><span class="hint">no device detail</span>`;
  }
  const pct = Math.round((done / (total || 1)) * 100);
  const cls = s === "failed" || s === "cancelled" ? "is-bad" : pct >= 100 ? "is-ok" : "is-live";
  return `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span class="bar-fill ${cls}" style="width:${Math.max(pct, 4)}%"></span></div><span class="hint tnum">${done} of ${total}</span>`;
}

function isFinal(status) {
  const s = (status || "").toLowerCase();
  return ["succeeded", "complete", "completed", "migrated", "failed", "error"].some((t) => s.includes(t));
}

function statusTag(status) {
  const s = (status || "").toLowerCase();
  const label = s === "in-progress" ? "in progress" : s === "partially-complete" ? "partly complete" : s || "unknown";
  if (s === "complete" || s === "completed" || s === "succeeded") return `<span class="tag tag-ok">${escapeHtml(label)}</span>`;
  if (s === "failed" || s === "cancelled" || s === "error") return `<span class="tag tag-bad">${escapeHtml(label)}</span>`;
  if (s === "partially-complete") return `<span class="tag tag-warn">${escapeHtml(label)}</span>`;
  return `<span class="tag tag-warn"><span class="conn-dot dot-pulse" data-state="loading"></span>${escapeHtml(label)}</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
