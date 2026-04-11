import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";

async function boot() {
  const ids = loadSelection();
  const direction = sessionStorage.getItem("migrationDirection") || "source-to-dest";
  const fromLabel = direction === "source-to-dest" ? "source" : "destination";
  const toLabel = direction === "source-to-dest" ? "destination" : "source";

  document.getElementById("direction-display").innerHTML =
    `Moving <strong>${ids.length}</strong> endpoint${ids.length === 1 ? "" : "s"} from <strong>${fromLabel}</strong> to <strong>${toLabel}</strong>.`;

  // Store direction on the form for use in submission
  document.getElementById("migrate-form").dataset.direction = direction;
  renderSelection(ids);
  wireForm(ids);
}

function loadSelection() {
  try {
    return JSON.parse(sessionStorage.getItem("endpointSelection") || "[]");
  } catch {
    return [];
  }
}

async function renderSelection(ids) {
  const list = document.getElementById("selection-list");
  if (ids.length === 0) {
    list.innerHTML = `<div class="empty-state">No endpoints selected. Pick devices on the <a href="/endpoints.html">Endpoints</a> page first.</div>`;
    return;
  }
  list.innerHTML = `<p><strong>${ids.length}</strong> endpoint${ids.length === 1 ? "" : "s"} selected for migration.</p>`;

  // Best-effort enrich with hostnames
  try {
    const details = [];
    for (const id of ids.slice(0, 30)) {
      try {
        const ep = await api.get(`/api/source/endpoints/${encodeURIComponent(id)}`);
        details.push({ id, hostname: ep.hostname || "(unknown)", lastSeen: ep.lastSeenAt });
      } catch {
        details.push({ id, hostname: "(load failed)", lastSeen: null });
      }
    }
    const rows = details
      .map((d) => `<li><code>${escapeHtml(d.id)}</code> · ${escapeHtml(d.hostname)}</li>`)
      .join("");
    const more = ids.length > 30 ? `<p class="hint">… and ${ids.length - 30} more.</p>` : "";
    list.innerHTML += `<ul style="margin-top:0.75rem; font-size: 0.85rem;">${rows}</ul>${more}`;
  } catch {
    // ignore enrichment failures
  }
}

function wireForm(ids) {
  const startBtn = document.getElementById("start-btn");
  const dryBtn = document.getElementById("dry-run-btn");
  const ack = document.getElementById("ack-window");
  const form = document.getElementById("migrate-form");

  ack.addEventListener("change", () => {
    startBtn.disabled = !ack.checked;
  });

  dryBtn.addEventListener("click", async () => {
    const jobName = form.jobName.value.trim();
    const dir = form.dataset.direction || "source-to-dest";
    if (!jobName) {
      toast("Enter a job name first.", "info");
      return;
    }
    if (!ids.length) {
      toast("No endpoints selected.", "info");
      return;
    }
    showResult("info", "Running dry-run preflight…");
    try {
      const res = await api.post("/api/migrate/devices?dryRun=true", {
        jobName,
        endpointIds: ids,
        direction: dir,
      });
      if (res.dryRun && res.plan) {
        showResult(
          "ok",
          `Dry run OK. Would create receiver job on ${escapeHtml(res.plan.destApiHost)} and sender job on ${escapeHtml(res.plan.sourceApiHost)} for ${ids.length} endpoint(s).`,
        );
      } else {
        showResult("ok", "Dry run complete.");
      }
    } catch (err) {
      if (err.body?.preflightFailures) {
        showResult(
          "err",
          `Preflight failed for ${err.body.preflightFailures.length} endpoint(s):<br/>` +
            err.body.preflightFailures
              .map((f) => `<code>${escapeHtml(f.hostname || f.endpointId)}</code> — ${escapeHtml(f.reason)}`)
              .join("<br/>"),
        );
      } else {
        showResult("err", err.message || "Dry run failed");
      }
    }
  });

  startBtn.addEventListener("click", async () => {
    const jobName = form.jobName.value.trim();
    if (!jobName) {
      toast("Enter a job name.", "info");
      return;
    }
    if (!confirm(`Create migration jobs for ${ids.length} endpoint(s)?\n\nThis is a real production action.`)) return;

    showResult("info", "Creating migration jobs…");
    try {
      const dir = form.dataset.direction || "source-to-dest";
      const res = await api.post("/api/migrate/devices", { jobName, endpointIds: ids, direction: dir });
      if (res.ok && res.job) {
        sessionStorage.removeItem("endpointSelection");
        window.location.href = `/migrate-job-detail.html?id=${encodeURIComponent(res.job.localJobId)}`;
      }
    } catch (err) {
      if (err.body?.preflightFailures) {
        showResult(
          "err",
          `Preflight failed:<br/>` +
            err.body.preflightFailures
              .map((f) => `<code>${escapeHtml(f.hostname || f.endpointId)}</code> — ${escapeHtml(f.reason)}`)
              .join("<br/>"),
        );
      } else {
        showResult("err", err.message || "Migration start failed");
      }
    }
  });
}

function showResult(variant, html) {
  document.getElementById("result-area").innerHTML =
    `<div class="banner banner-${variant}">${html}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
