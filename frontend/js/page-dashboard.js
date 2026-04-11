import "./nav.js";
import { api } from "./api.js";
import { getPreloadStatus, refreshSection, startPreload } from "./preload-client.js";
import { toast } from "./toast.js";

const SECTIONS = [
  { id: "policies", label: "Policies", href: "/policies.html" },
  { id: "groups", label: "Groups", href: "/groups.html" },
  { id: "scanning-exclusions", label: "Scanning exclusions", href: "/exclusions.html" },
  { id: "allowed-items", label: "Allowed items", href: "/exclusions.html" },
  { id: "blocked-items", label: "Blocked items", href: "/exclusions.html" },
  { id: "endpoints", label: "Endpoints", href: "/endpoints.html" },
];

let pollHandle = null;

async function boot() {
  await loadStatus();
  // Poll until everything settles, then stop
  pollHandle = setInterval(async () => {
    const stop = await loadStatus();
    if (stop) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }, 3000);

  document.getElementById("preload-restart").addEventListener("click", async () => {
    try {
      await startPreload();
      toast("Preload restarted.", "info");
      if (!pollHandle) {
        pollHandle = setInterval(async () => {
          const stop = await loadStatus();
          if (stop) {
            clearInterval(pollHandle);
            pollHandle = null;
          }
        }, 3000);
      }
    } catch (err) {
      toast(err.message || "Restart failed", "err");
    }
  });
}

async function loadStatus() {
  let tenantStatus, preload;
  try {
    [tenantStatus, preload] = await Promise.all([
      api.get("/api/status"),
      getPreloadStatus(),
    ]);
  } catch (err) {
    document.getElementById("preload-grid").innerHTML =
      `<div class="banner banner-err">${escapeHtml(err.message || "Failed to load preload status")}</div>`;
    return true;
  }

  renderTenantTiles(tenantStatus);
  renderPreloadGrid(preload);

  // Stop polling once nothing is "loading" anymore
  const stillLoading = ["source", "dest"].some((side) =>
    SECTIONS.some((s) => preload[side][s.id]?.state === "loading"),
  );
  return !stillLoading;
}

function renderTenantTiles(status) {
  if (!status) return;
  renderTile("source", status.source);
  renderTile("dest", status.dest);
}

function renderTile(side, data) {
  const body = document.querySelector(`[data-body="${side}"]`);
  if (!body) return;
  if (!data?.configured) {
    body.innerHTML = `
      <div class="tile-status tile-unconfigured"><span class="dot dot-red"></span>Not configured</div>
      <p>Enter credentials on the <a href="/credentials.html">Credentials</a> page.</p>
    `;
    return;
  }
  if (!data.ok) {
    body.innerHTML = `
      <div class="tile-status tile-error"><span class="dot dot-amber"></span>Connection failed</div>
      <pre class="error-pre">${escapeHtml(data.error || "")}</pre>
      <p><a href="/credentials.html">Update credentials</a></p>
    `;
    return;
  }
  const id = data.identity;
  const labelRow = id.displayName
    ? `<dt>Label</dt><dd><strong>${escapeHtml(id.displayName)}</strong></dd>`
    : `<dt>Label</dt><dd><span class="hint">— set one on the <a href="/credentials.html">Credentials</a> page</span></dd>`;
  const regionRow = id.region
    ? `<dt>Region</dt><dd><code>${escapeHtml(id.region)}</code></dd>`
    : "";
  body.innerHTML = `
    <div class="tile-status tile-ok"><span class="dot dot-green"></span>Connected</div>
    <dl class="kv-list">
      ${labelRow}
      <dt>Tenant ID</dt><dd><code>${escapeHtml(id.tenantId)}</code></dd>
      ${regionRow}
      <dt>API host</dt><dd><code>${escapeHtml(id.apiHost)}</code></dd>
    </dl>
  `;
}

function renderPreloadGrid(preload) {
  const target = document.getElementById("preload-grid");
  if (!preload) {
    target.innerHTML = `<div class="empty-state">No preload status available.</div>`;
    return;
  }

  const summary = computeSummary(preload);
  const summaryHtml = `
    <div class="preload-summary">
      <span class="diff-pill diff-pill-add">${summary.ok} loaded</span>
      <span class="diff-pill diff-pill-change">${summary.loading} loading</span>
      <span class="diff-pill diff-pill-remove">${summary.error} failed</span>
      <span class="diff-pill" style="background: var(--surface-3); color: var(--text-muted);">${summary.idle} idle</span>
    </div>
  `;

  const rows = SECTIONS.map((section) => {
    const sourceCell = renderCell("source", section.id, preload.source[section.id]);
    const destCell = renderCell("dest", section.id, preload.dest[section.id]);
    return `
      <tr>
        <td><a href="${section.href}">${escapeHtml(section.label)}</a></td>
        <td>${sourceCell}</td>
        <td>${destCell}</td>
      </tr>
    `;
  }).join("");

  target.innerHTML = `
    ${summaryHtml}
    <table class="data-table preload-table">
      <thead>
        <tr><th>Section</th><th>Source</th><th>Destination</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  target.querySelectorAll("[data-refresh]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const [side, section] = e.target.dataset.refresh.split("::");
      e.target.disabled = true;
      try {
        await refreshSection(side, section);
        toast(`Refreshed ${section} (${side}).`, "ok");
      } catch (err) {
        toast(err.message || "Refresh failed", "err");
      } finally {
        await loadStatus();
      }
    });
  });
}

function computeSummary(preload) {
  const counts = { ok: 0, loading: 0, error: 0, idle: 0 };
  for (const side of ["source", "dest"]) {
    for (const section of SECTIONS) {
      const s = preload[side][section.id]?.state ?? "idle";
      counts[s] = (counts[s] ?? 0) + 1;
    }
  }
  return counts;
}

function renderCell(side, sectionId, status) {
  if (!status) {
    return `<span class="preload-cell preload-idle">idle</span>`;
  }
  const stateClass = `preload-${status.state}`;
  let detail = "";
  if (status.state === "ok") {
    detail = `${status.itemCount} items · ${formatDuration(status.durationMs)}`;
  } else if (status.state === "loading") {
    detail = "in progress…";
  } else if (status.state === "error") {
    detail = (status.error || "").slice(0, 80);
  } else {
    detail = "idle";
  }
  return `
    <span class="preload-cell ${stateClass}">
      <span class="dot dot-${dotForState(status.state)}"></span>
      <span class="preload-state-label">${status.state}</span>
      <span class="preload-detail" title="${escapeAttr(status.error ?? detail)}">${escapeHtml(detail)}</span>
      <button class="btn btn-small" data-refresh="${side}::${sectionId}">Refresh</button>
    </span>
  `;
}

function dotForState(state) {
  if (state === "ok") return "green";
  if (state === "error") return "red";
  if (state === "loading") return "amber";
  return "idle";
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

boot();
