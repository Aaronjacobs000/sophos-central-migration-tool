import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";

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

  document.getElementById("cancel-btn").addEventListener("click", () => cancelJob(id));
  document.getElementById("refresh-btn").addEventListener("click", () => manualRefresh(id));

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
  btn.textContent = "Refreshing…";
  try {
    const job = await api.get(`/api/migrate/devices/jobs/${encodeURIComponent(id)}`);
    currentJob = job;
    render(job);
    toast("Refreshed from API.", "ok");
  } catch (err) {
    toast(err.message || "Refresh failed", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh now";
  }
}

function render(job) {
  document.getElementById("job-title").textContent = `Migration: ${job.jobName}`;

  const created = new Date(job.createdAt);
  const elapsed = formatElapsed(created);
  document.getElementById("job-lead").textContent =
    `Local job ID ${job.localJobId} · created ${created.toLocaleString()} · elapsed ${elapsed}`;

  // Warnings
  renderWarnings(job);

  // Core metadata
  const meta = document.getElementById("job-meta");
  meta.innerHTML = `
    <dl class="kv-list">
      <dt>Aggregate status</dt>
      <dd><span class="diff-pill ${statusClass(job.status)}">${esc(job.status)}</span></dd>
      <dt>Direction</dt><dd>${esc(job.direction || "—")}</dd>
      <dt>Endpoints</dt><dd>${job.endpointIds.length}</dd>
      <dt>Last polled</dt>
      <dd>${job.lastPolledAt ? new Date(job.lastPolledAt).toLocaleString() : "—"}</dd>
    </dl>
    ${job.lastError ? `<div class="banner banner-warn" style="margin-top:0.75rem;">${esc(job.lastError)}</div>` : ""}
  `;

  // Source / dest API panels
  renderApiStatus(job);

  // Per-endpoint grid
  renderEndpoints(job);
}

function renderWarnings(job) {
  const el = document.getElementById("job-warnings");
  const warnings = [];

  if (job.status === "in-progress") {
    const ageMs = Date.now() - new Date(job.createdAt).getTime();
    if (ageMs > 10 * 60 * 1000) {
      warnings.push(
        `This migration has been in-progress for ${formatElapsed(new Date(job.createdAt))}. ` +
        `If the endpoint is online and checking in, this may indicate a problem. ` +
        `Check the source and dest API status panels below for error details.`
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
  if (dstErr) warnings.push(`Dest API error: ${dstErr}`);

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
    .map((w) => `<div class="banner banner-warn" style="margin-bottom:0.75rem;">${esc(w)}</div>`)
    .join("");
}

function renderApiStatus(job) {
  const container = document.getElementById("api-status");
  container.innerHTML = `
    <div class="panel-card" style="margin:0;">
      <h4 style="margin:0 0 0.5rem;">Source (sender)</h4>
      ${renderSnapshot(job.sourceSnapshot, "source", job.sourceMigrationId)}
    </div>
    <div class="panel-card" style="margin:0;">
      <h4 style="margin:0 0 0.5rem;">Dest (receiver)</h4>
      ${renderSnapshot(job.destSnapshot, "dest", job.destMigrationId)}
    </div>
  `;
}

function renderSnapshot(snap, side, migrationId) {
  if (!snap) {
    return `<div class="banner banner-warn">No data from ${side} API. The job may have been deleted upstream or the API returned an error.</div>`;
  }

  const counts = snap.endpointCounts || {};
  const countsHtml = (counts.total != null)
    ? `<dt>Endpoints</dt><dd>${counts.total ?? 0} total, ${counts.successful ?? 0} ok, ${counts.failed ?? 0} failed, ${counts.pending ?? 0} pending</dd>`
    : "";

  const errorHtml = (snap.errorCode || snap.errorMessage)
    ? `<div class="banner banner-err" style="margin-top:0.5rem;">
        ${snap.errorCode ? `<strong>${esc(snap.errorCode)}</strong>: ` : ""}${esc(snap.errorMessage || "Unknown error")}
       </div>`
    : "";

  const finished = snap.finishedAt
    ? `<dt>Finished</dt><dd>${new Date(snap.finishedAt).toLocaleString()}</dd>`
    : "";

  return `
    <dl class="kv-list" style="font-size:0.8rem;">
      <dt>Migration ID</dt><dd><code>${esc(migrationId)}</code></dd>
      <dt>API status</dt><dd><span class="diff-pill ${statusClass(snap.status)}">${esc(snap.status || "—")}</span></dd>
      <dt>Mode</dt><dd>${esc(snap.mode || snap.type || "—")}</dd>
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
  grid.innerHTML = Array.from(merged.values())
    .map((m) => {
      const srcStatus = m.source?.status || "—";
      const dstStatus = m.dest?.status || "—";
      const srcError = m.source?.errorMessage || m.source?.errorCode || "";
      const dstError = m.dest?.errorMessage || m.dest?.errorCode || "";
      const hasError = srcError || dstError;

      return `
      <div class="job-status-cell ${hasError ? "job-status-error" : ""}">
        <div class="hostname">${esc(m.hostname || m.id)}</div>
        <div class="state ${epStatusClass(srcStatus)}">source: ${esc(srcStatus)}</div>
        ${srcError ? `<div class="ep-error">${esc(srcError)}</div>` : ""}
        <div class="state ${epStatusClass(dstStatus)}">dest: ${esc(dstStatus)}</div>
        ${dstError ? `<div class="ep-error">${esc(dstError)}</div>` : ""}
      </div>`;
    })
    .join("");
}

async function cancelJob(id) {
  if (!confirm("Cancel this migration?\n\nThis deletes both upstream sender and receiver jobs.")) return;
  try {
    await api.del(`/api/migrate/devices/jobs/${encodeURIComponent(id)}`);
    toast("Migration cancelled.", "info");
  } catch (err) {
    toast(err.message || "Cancel failed", "err");
  }
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
  if (s === "complete" || s === "completed" || s === "succeeded") return "diff-pill-add";
  if (s === "failed" || s === "cancelled" || s === "error") return "diff-pill-remove";
  return "diff-pill-change";
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
