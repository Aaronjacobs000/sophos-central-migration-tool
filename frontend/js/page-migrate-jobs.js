import "./nav.js";
import { api } from "./api.js";
import { makeSortable } from "./sortable.js";
import { icon } from "./icons.js";
import { statusTag, progressRing, accessProblem, jobSides } from "./migration-view.js";

// The list refreshes itself, so it can stay open while jobs run. Each load
// also asks the server to check unfinished jobs in the background.
const REFRESH_MS = 30_000;

let currentTab = "all";
let loading = false;
let lastSort = null;

async function boot() {
  // Wire up tab buttons
  for (const btn of document.querySelectorAll("#jobs-tabs .tab-btn")) {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      for (const b of document.querySelectorAll("#jobs-tabs .tab-btn")) {
        b.classList.toggle("active", b === btn);
      }
      lastSort = null;
      load(true);
    });
  }
  await load(true);
  setInterval(() => load(false), REFRESH_MS);
}

async function load(showLoading) {
  if (loading) return;
  loading = true;
  const container = document.getElementById("jobs-list");
  if (showLoading) container.innerHTML = `<div class="empty-state">Loading</div>`;
  try {
    const endpoint = currentTab === "all"
      ? "/api/migrate/devices/jobs/all"
      : "/api/migrate/devices/jobs";
    const res = await api.get(endpoint);
    rememberSort(container);
    render((res.items || []).map((j) => ("progress" in j && j.origin === undefined ? { ...j, origin: "local", endpointCount: j.endpointIds?.length } : j)));
    restoreSort(container);
    document.getElementById("jobs-updated").textContent = `Updated ${new Date().toLocaleTimeString()}. Refreshes every 30 seconds.`;
  } catch (err) {
    if (showLoading || !container.querySelector("table")) {
      container.innerHTML = `<div class="banner banner-err">${escapeHtml(err.message || "Failed to load")}</div>`;
    }
    document.getElementById("jobs-updated").textContent = `Refresh failed at ${new Date().toLocaleTimeString()}. Retrying.`;
  } finally {
    loading = false;
  }
}

function rememberSort(container) {
  const th = container.querySelector("th.sort-asc, th.sort-desc");
  if (!th) return;
  lastSort = { index: [...th.parentElement.children].indexOf(th), dir: th.classList.contains("sort-asc") ? "asc" : "desc" };
}

function restoreSort(container) {
  if (!lastSort) return;
  const th = container.querySelectorAll("thead th")[lastSort.index];
  if (!th) return;
  th.click();
  if (lastSort.dir === "desc") th.click();
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

      const sides = isLocal && j.tenants ? jobSides(j) : null;
      const route = sides ? `<span class="job-name-sub">${escapeHtml(sides.sending.name)} to ${escapeHtml(sides.receiving.name)}</span>` : "";
      const nameCell = j.localJobId
        ? `<a href="/migrate-job-detail.html?id=${encodeURIComponent(j.localJobId)}">${escapeHtml(j.jobName)}</a>${route}`
        : `<span class="cell-name">${escapeHtml(j.jobName)}</span>`;

      const epCount = j.endpointCount != null ? j.endpointCount : "-";

      // Sophos gives both tenants the same migration job ID, so one column holds it.
      const jobIdOf = j.destMigrationId || j.sourceMigrationId;
      const migrationId = jobIdOf
        ? `<code title="${escapeHtml(jobIdOf)}">${escapeHtml(jobIdOf.slice(0, 8))}</code>`
        : "-";

      const apiInfo = !isLocal
        ? `<code>${escapeHtml((j.apiMigrationId || "").slice(0, 8))}</code>
           <span class="hint">${escapeHtml(j.apiJobMode || "")} on ${escapeHtml(j.apiTenant === "dest" ? "destination" : j.apiTenant || "")}</span>`
        : "";

      return `
        <tr>
          <td>${nameCell}</td>
          <td>${originBadge}</td>
          <td>${statusCell(j)}</td>
          <td class="job-progress">${progressCell(j)}</td>
          <td class="tnum">${epCount}</td>
          <td class="cell-nowrap"><span class="hint">${created}</span></td>
          <td>${isLocal ? migrationId : apiInfo || migrationId}</td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="table-wrap">
    <table class="data-table jobs-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Origin</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Devices</th>
          <th>Created</th>
          <th>Migration job</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  `;
  makeSortable(container);
}

// Local jobs carry their status and progress from the server. Jobs found only
// on a tenant's API (started elsewhere) have no device detail.
function statusCell(j) {
  if (!j.progress) {
    return `<span class="tag tag-muted" title="Started outside this tool, so the tool does not follow its devices">${escapeHtml(j.status && j.status !== "unknown" ? j.status : "not followed")}</span>`;
  }
  const problem = accessProblem(j);
  const note = problem
    ? `<span class="tag tag-${problem.tone === "bad" ? "bad" : "muted"}" title="${escapeHtml(j.monitor?.message || "")}">${icon(problem.icon)}${escapeHtml(problem.short)}</span>`
    : "";
  const stale = ["rejected", "no-credentials", "not-found"].includes(j.monitor?.state);
  return `<div class="status-stack">${statusTag(j.status, { paused: stale })}${note}</div>`;
}

// The same ring as the job page, small: the share of devices that have arrived.
function progressCell(j) {
  if (!j.progress) {
    return `<div class="job-ring-cell">${progressRing(null, { size: "sm" })}<span class="hint">no device detail</span></div>`;
  }
  const p = j.progress;
  const stale = ["rejected", "no-credentials", "not-found"].includes(j.monitor?.state);
  const failed = p.failed + p.expired;
  const detail = `<span>${p.arrived} of ${p.total} arrived</span>${failed ? `<span class="is-bad">${failed} failed</span>` : ""}`;
  return `<div class="job-ring-cell">${progressRing(p, { size: "sm", stale })}<span class="hint tnum ring-note">${detail}</span></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
