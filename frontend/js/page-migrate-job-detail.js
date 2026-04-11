import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    document.getElementById("job-meta").innerHTML =
      `<div class="banner banner-err">Missing job id.</div>`;
    return;
  }

  document.getElementById("cancel-btn").addEventListener("click", () => cancelJob(id));

  // Open SSE stream
  const es = new EventSource(`/api/migrate/devices/jobs/${encodeURIComponent(id)}/stream`);
  es.addEventListener("status", (e) => {
    try {
      render(JSON.parse(e.data));
    } catch (err) {
      console.error("bad SSE payload", err);
    }
  });
  es.addEventListener("done", (e) => {
    try {
      const data = JSON.parse(e.data);
      toast(`Migration ${data.status ?? "finished"}.`, data.status === "complete" ? "ok" : "info");
    } catch {}
    es.close();
  });
  es.addEventListener("error", () => {
    // EventSource will auto-reconnect; toast just to inform
    toast("Live updates interrupted, retrying…", "info");
  });
}

function render(job) {
  document.getElementById("job-title").textContent = `Migration: ${job.jobName}`;
  document.getElementById("job-lead").textContent =
    `Local job ID ${job.localJobId} · created ${new Date(job.createdAt).toLocaleString()}`;

  const meta = document.getElementById("job-meta");
  meta.innerHTML = `
    <dl class="kv-list">
      <dt>Status</dt><dd><span class="diff-pill ${statusClass(job.status)}">${escapeHtml(job.status)}</span></dd>
      <dt>Source migration ID</dt><dd><code>${escapeHtml(job.sourceMigrationId)}</code></dd>
      <dt>Dest migration ID</dt><dd><code>${escapeHtml(job.destMigrationId)}</code></dd>
      <dt>Endpoints</dt><dd>${job.endpointIds.length}</dd>
      <dt>Last polled</dt><dd>${job.lastPolledAt ? new Date(job.lastPolledAt).toLocaleString() : "—"}</dd>
    </dl>
    ${job.lastError ? `<div class="banner banner-warn">${escapeHtml(job.lastError)}</div>` : ""}
  `;

  // Per-endpoint grid: merge source + dest endpoint detail snapshots
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
    .map(
      (m) => `
      <div class="job-status-cell">
        <div class="hostname">${escapeHtml(m.hostname || m.id)}</div>
        <div class="state">source: ${escapeHtml(m.source?.status || "—")}</div>
        <div class="state">dest: ${escapeHtml(m.dest?.status || "—")}</div>
      </div>`,
    )
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

function statusClass(status) {
  if (status === "complete") return "diff-pill-add";
  if (status === "failed" || status === "cancelled") return "diff-pill-remove";
  return "diff-pill-change";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
