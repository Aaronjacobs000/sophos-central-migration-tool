import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";
import { esc as escHtml } from "./ui.js";

let currentJob = null;
let eventSource = null;

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    document.getElementById("job-meta").innerHTML =
      `<div class="banner banner-err">Missing job id.</div>`;
    return;
  }

  document.getElementById("refresh-btn").addEventListener("click", () => manualRefresh(id));
  document.getElementById("membership-preview").addEventListener("click", () => loadMembership(id, true));
  document.getElementById("membership-apply").addEventListener("click", () => applyMembership(id));

  connectStream(id);
}

function connectStream(id) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/migrate/devices/jobs/${encodeURIComponent(id)}/stream`);
  eventSource.addEventListener("status", (e) => {
    try {
      currentJob = JSON.parse(e.data);
      render(currentJob);
    } catch (err) {
      console.error("bad SSE payload", err);
    }
  });
  eventSource.addEventListener("done", (e) => {
    try {
      const data = JSON.parse(e.data);
      toast(`Migration ${data.status ?? "finished"}.`, data.status === "complete" ? "ok" : "info");
    } catch {}
    eventSource.close();
  });
  eventSource.addEventListener("error", () => {
    toast("Live updates interrupted, retrying…", "info");
  });
}

async function manualRefresh(id) {
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  try {
    const job = await api.get(`/api/migrate/devices/jobs/${encodeURIComponent(id)}`);
    currentJob = job;
    render(job);
    toast("Refreshed from API.", "ok");
  } catch (err) {
    toast(err.message || "Refresh failed", "err");
  } finally {
    btn.disabled = false;
  }
}

function render(job) {
  document.getElementById("job-title").textContent = job.jobName;

  const created = new Date(job.createdAt);
  const elapsed = formatElapsed(created);
  document.getElementById("job-lead").textContent =
    `Created ${created.toLocaleString()}, ${elapsed} ago. Local job ID ${job.localJobId}.`;

  // Warnings
  renderWarnings(job);

  document.getElementById("job-status").innerHTML = statusTag(job.status);
  renderProgress(job);

  // Core metadata
  const meta = document.getElementById("job-meta");
  const toSource = job.direction === "dest-to-source";
  meta.innerHTML = `
    <dl class="kv-list meta-inline">
      <dt>Direction</dt><dd><span class="tag ${toSource ? "tag-dst" : "tag-src"}">${toSource ? "destination" : "source"}</span> ${icon("arrowRight")} <span class="tag ${toSource ? "tag-src" : "tag-dst"}">${toSource ? "source" : "destination"}</span></dd>
      <dt>Devices</dt><dd class="tnum">${job.endpointIds.length}</dd>
      <dt>Last polled</dt>
      <dd>${job.lastPolledAt ? new Date(job.lastPolledAt).toLocaleString() : "not yet"}</dd>
    </dl>
    ${job.lastError ? `<div class="banner banner-warn">${esc(job.lastError)}</div>` : ""}
  `;

  // Source / dest API panels
  renderApiStatus(job);

  // Per-endpoint grid
  renderEndpoints(job);

  // Preview group membership once, the first time any device has moved.
  if (!membershipPreviewed && hasMovedDevice(job)) {
    membershipPreviewed = true;
    loadMembership(job.localJobId, true);
  }
}

// ---------- group membership after the move ----------

let membershipPreviewed = false;

function hasMovedDevice(job) {
  const all = [...(job.sourceSnapshot?.endpointDetails ?? []), ...(job.destSnapshot?.endpointDetails ?? [])];
  return all.some((e) => epStatusClass(e.status) === "ep-ok");
}

const MEMBERSHIP_TAG = {
  "will-add": ["tag-accent", "will add"],
  added: ["tag-ok", "added"],
  "already-member": ["tag-muted", "already in group"],
  "no-group": ["tag-muted", "no group"],
  "group-missing": ["tag-warn", "group missing"],
  "not-moved": ["tag-muted", "not moved yet"],
  "move-failed": ["tag-bad", "move failed"],
  "no-new-id": ["tag-warn", "no new ID"],
  error: ["tag-bad", "failed"],
};

async function loadMembership(id, dryRun) {
  const body = document.getElementById("membership-body");
  body.innerHTML = `<p class="hint"><span class="spin"></span> ${dryRun ? "Working out which devices go where" : "Adding devices to groups"}</p>`;
  try {
    const res = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(id)}/group-membership`, { dryRun });
    renderMembership(res);
    return res;
  } catch (err) {
    body.innerHTML = `<div class="banner banner-err">${escHtml(err.message || "Group membership check failed")}</div>`;
    return null;
  }
}

async function applyMembership(id) {
  const toAdd = document.getElementById("membership-apply").dataset.count;
  if (!confirm(`Add ${toAdd} moved device(s) to their destination groups?\n\nThis writes to the receiving tenant.`)) return;
  const res = await loadMembership(id, false);
  if (!res) return;
  const failed = res.counts.error ?? 0;
  toast(`Added ${res.counts.added ?? 0} device(s) to groups${failed ? `, ${failed} failed` : ""}.`, failed ? "err" : "ok");
}

function renderMembership(res) {
  const c = res.counts;
  const willAdd = c["will-add"] ?? 0;
  const apply = document.getElementById("membership-apply");
  apply.disabled = willAdd === 0;
  apply.dataset.count = String(willAdd);
  const parts = [];
  if (res.dryRun && willAdd) parts.push(`<span class="tag tag-accent">${willAdd} to add</span>`);
  if (c.added) parts.push(`<span class="tag tag-ok">${c.added} added</span>`);
  if (c["group-missing"]) parts.push(`<span class="tag tag-warn">${c["group-missing"]} group missing</span>`);
  if (c.error) parts.push(`<span class="tag tag-bad">${c.error} failed</span>`);
  document.getElementById("membership-summary").innerHTML = parts.join(" ");

  const rows = res.rows.map((r) => {
    const [cls, label] = MEMBERSHIP_TAG[r.status] ?? ["tag-muted", r.status];
    return `
      <tr>
        <td><span class="cell-name">${escHtml(r.hostname)}</span></td>
        <td>${r.sourceGroup ? escHtml(r.sourceGroup) : `<span class="hint">none</span>`}</td>
        <td><span class="tag ${cls}">${escHtml(label)}</span></td>
        <td><span class="hint">${escHtml(r.message || "")}</span></td>
      </tr>`;
  }).join("");
  document.getElementById("membership-body").innerHTML = `
    <table class="data-table">
      <thead><tr><th>Device</th><th>Source group</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint check-foot">${res.dryRun ? "Preview only. Nothing was written." : "Each group change is in data/audit.log."}</p>`;
}

function renderWarnings(job) {
  const el = document.getElementById("job-warnings");
  const warnings = [];

  if (job.status === "in-progress") {
    const ageMs = Date.now() - new Date(job.createdAt).getTime();
    if (ageMs > 10 * 60 * 1000) {
      warnings.push(
        `This migration has been in progress for ${formatElapsed(new Date(job.createdAt))}. ` +
        `If the devices are online and checking in, something may be wrong. ` +
        `Check the upstream jobs below for error details.`
      );
    } else if (ageMs > 5 * 60 * 1000) {
      warnings.push(
        `Migration has been running for ${formatElapsed(new Date(job.createdAt))}. ` +
        `Most migrations complete within a few minutes.`
      );
    }
  }

  // Check for API-level errors on either side
  const srcErr = job.sourceSnapshot?.errorMessage || job.sourceSnapshot?.errorCode;
  const dstErr = job.destSnapshot?.errorMessage || job.destSnapshot?.errorCode;
  if (srcErr) warnings.push(`Source API error: ${srcErr}`);
  if (dstErr) warnings.push(`Destination API error: ${dstErr}`);

  // Check for per-endpoint errors
  const srcDetails = job.sourceSnapshot?.endpointDetails ?? [];
  const dstDetails = job.destSnapshot?.endpointDetails ?? [];
  const allDetails = [...srcDetails, ...dstDetails];
  const epErrors = allDetails.filter((e) => e.errorMessage || e.errorCode);
  if (epErrors.length > 0) {
    const unique = [...new Set(epErrors.map((e) => e.errorMessage || e.errorCode))];
    warnings.push(`${epErrors.length} endpoint error(s): ${unique.join("; ")}`);
  }

  if (warnings.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = warnings
    .map((w) => `<div class="banner banner-warn">${esc(w)}</div>`)
    .join("");
}

function renderApiStatus(job) {
  const container = document.getElementById("api-status");
  container.innerHTML = `
    <div>
      <h3 class="side-title">Source</h3>
      ${renderSnapshot(job.sourceSnapshot, "source", job.sourceMigrationId)}
    </div>
    <div>
      <h3 class="side-title is-dest">Destination</h3>
      ${renderSnapshot(job.destSnapshot, "dest", job.destMigrationId)}
    </div>
  `;
}

function renderSnapshot(snap, side, migrationId) {
  if (!snap) {
    return `<div class="banner banner-warn">No data from the ${side === "dest" ? "destination" : "source"} API. The job may have been deleted upstream or the API returned an error.</div>`;
  }

  const counts = snap.endpointCounts || {};
  const countsHtml = (counts.total != null)
    ? `<dt>Endpoints</dt><dd>${counts.total ?? 0} total, ${counts.successful ?? 0} ok, ${counts.failed ?? 0} failed, ${counts.pending ?? 0} pending</dd>`
    : "";

  const errorHtml = (snap.errorCode || snap.errorMessage)
    ? `<div class="banner banner-err">
        ${snap.errorCode ? `<strong>${esc(snap.errorCode)}</strong>: ` : ""}${esc(snap.errorMessage || "Unknown error")}
       </div>`
    : "";

  const finished = snap.finishedAt
    ? `<dt>Finished</dt><dd>${new Date(snap.finishedAt).toLocaleString()}</dd>`
    : "";

  return `
    <dl class="kv-list">
      <dt>Migration ID</dt><dd><code>${esc(migrationId)}</code></dd>
      <dt>API status</dt><dd>${snap.status ? `<span class="tag ${statusClass(snap.status)}">${esc(snap.status)}</span>` : `<span class="hint">not reported</span>`}</dd>
      <dt>Mode</dt><dd>${esc(snap.mode || snap.type || "not reported")}</dd>
      ${countsHtml}
      ${finished}
    </dl>
    ${errorHtml}
  `;
}

function renderEndpoints(job) {
  const grid = document.getElementById("endpoint-grid");
  const merged = new Map();
  const srcDetails = job.sourceSnapshot?.endpointDetails ?? [];
  const dstDetails = job.destSnapshot?.endpointDetails ?? [];
  for (const id of job.endpointIds) {
    const hostname = job.endpointHostnames?.[id] || id;
    merged.set(id, { id, hostname, source: null, dest: null });
  }
  for (const e of srcDetails) {
    if (merged.has(e.id)) merged.get(e.id).source = e;
  }
  for (const e of dstDetails) {
    if (merged.has(e.id)) merged.get(e.id).dest = e;
  }
  const rows = Array.from(merged.values())
    .map((m) => {
      const srcError = m.source?.errorMessage || m.source?.errorCode || "";
      const dstError = m.dest?.errorMessage || m.dest?.errorCode || "";
      const errors = [srcError && `Source: ${srcError}`, dstError && `Destination: ${dstError}`].filter(Boolean);
      return `
      <tr${errors.length ? ' class="has-error"' : ""}>
        <td><span class="cell-name">${esc(m.hostname || m.id)}</span></td>
        <td>${epState(m.source?.status)}</td>
        <td>${epState(m.dest?.status)}</td>
        <td>${errors.length ? `<span class="ep-error">${esc(errors.join(" · "))}</span>` : `<span class="hint">none</span>`}</td>
      </tr>`;
    })
    .join("");
  grid.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Device</th><th><span class="side-title">Source</span></th><th><span class="side-title is-dest">Destination</span></th><th>Errors</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function formatElapsed(since) {
  const ms = Date.now() - since.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (s === "complete" || s === "completed" || s === "succeeded") return "tag-ok";
  if (s === "failed" || s === "cancelled" || s === "error") return "tag-bad";
  return "tag-warn";
}

function statusTag(status) {
  const s = (status || "").toLowerCase();
  const label = s === "in-progress" ? "in progress" : s === "partially-complete" ? "partly complete" : s || "unknown";
  const live = s === "in-progress" ? `<span class="conn-dot" data-state="loading"></span>` : "";
  return `<span class="tag ${statusClass(status)}">${live}${esc(label)}</span>`;
}

// Device-level state with a dot that pulses while the device is still pending.
function epState(status) {
  const s = (status || "").toLowerCase();
  if (!s) return `<span class="ep-state"><span class="conn-dot" data-state="unconfigured"></span><span class="hint">no data</span></span>`;
  const cls = epStatusClass(s);
  const state = cls === "ep-ok" ? "ok" : cls === "ep-fail" ? "error" : "loading";
  return `<span class="ep-state"><span class="conn-dot" data-state="${state}"></span>${esc(s)}</span>`;
}

function renderProgress(job) {
  const el = document.getElementById("job-progress");
  const byId = new Map();
  for (const e of [...(job.sourceSnapshot?.endpointDetails ?? []), ...(job.destSnapshot?.endpointDetails ?? [])]) {
    const prev = byId.get(e.id);
    if (!prev || epStatusClass(e.status) !== "") byId.set(e.id, e);
  }
  const total = job.endpointIds.length;
  let moved = 0;
  let failed = 0;
  for (const id of job.endpointIds) {
    const cls = epStatusClass(byId.get(id)?.status);
    if (cls === "ep-ok") moved++;
    else if (cls === "ep-fail") failed++;
  }
  const done = moved + failed;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const s = (job.status || "").toLowerCase();
  const cls = s === "failed" || s === "cancelled" ? "is-bad" : pct >= 100 ? "is-ok" : "is-live";
  el.innerHTML = `
    <div class="job-bar">
      <div class="bar bar-lg" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span class="bar-fill ${cls}" style="width:${Math.max(pct, 3)}%"></span></div>
      <span class="tnum job-bar-text"><strong>${moved}</strong> moved${failed ? `, <strong>${failed}</strong> failed` : ""}, ${total - done} pending of ${total}</span>
    </div>`;
}

function epStatusClass(status) {
  const s = (status || "").toLowerCase();
  if (s === "complete" || s === "completed" || s === "succeeded" || s === "migrated") return "ep-ok";
  if (s === "failed" || s === "error") return "ep-fail";
  return "";
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
