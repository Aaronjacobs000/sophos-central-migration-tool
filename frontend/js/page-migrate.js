import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";

async function boot() {
  const ids = loadSelection();
  const direction = sessionStorage.getItem("migrationDirection") || "source-to-dest";
  const fromLabel = direction === "source-to-dest" ? "source" : "destination";
  const toLabel = direction === "source-to-dest" ? "destination" : "source";

  document.getElementById("direction-display").innerHTML =
    `<span class="tag ${fromLabel === "source" ? "tag-src" : "tag-dst"}">${fromLabel}</span>${icon("arrowRight")}<span class="tag ${toLabel === "source" ? "tag-src" : "tag-dst"}">${toLabel}</span>`;

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
  list.innerHTML = `<p class="hint"><strong>${ids.length}</strong> device${ids.length === 1 ? "" : "s"} selected.</p>`;

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
      .map((d) => `<li><span class="sel-host">${escapeHtml(d.hostname)}</span><code class="sel-id">${escapeHtml(d.id)}</code></li>`)
      .join("");
    const more = ids.length > 30 ? `<p class="hint">And ${ids.length - 30} more.</p>` : "";
    list.innerHTML += `<ul class="sel-list">${rows}</ul>${more}`;
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
    showResult("info", `<span class="spin"></span> Running the dry-run preflight`);
    try {
      const res = await api.post("/api/migrate/devices?dryRun=true", {
        jobName,
        endpointIds: ids,
        direction: dir,
      });
      if (res.dryRun && res.plan) {
        showPlan(res.plan, dir);
      } else {
        showResult("ok", "Dry run complete.");
      }
    } catch (err) {
      if (err.body?.preflightFailures) {
        showFailures(err.body.preflightFailures);
      } else {
        showResult("err", migrationErrorHint(err.message || "Dry run failed"));
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

    showResult("info", `<span class="spin"></span> Creating migration jobs`);
    try {
      const dir = form.dataset.direction || "source-to-dest";
      const res = await api.post("/api/migrate/devices", { jobName, endpointIds: ids, direction: dir });
      if (res.ok && res.job) {
        sessionStorage.removeItem("endpointSelection");
        window.location.href = `/migrate-job-detail.html?id=${encodeURIComponent(res.job.localJobId)}`;
      }
    } catch (err) {
      if (err.body?.preflightFailures) {
        showFailures(err.body.preflightFailures);
      } else {
        showResult("err", migrationErrorHint(err.message || "Migration start failed"));
      }
    }
  });
}

function showResult(variant, html) {
  document.getElementById("result-area").innerHTML =
    `<div class="banner banner-${variant}">${html}</div>`;
}

// Dry-run result as the list of steps the real run would take.
function showPlan(plan, dir) {
  const count = plan.receiverBody?.endpoints?.length ?? 0;
  const toLabel = dir === "dest-to-source" ? "source" : "destination";
  const fromLabel = dir === "dest-to-source" ? "destination" : "source";
  const steps = [
    { title: "Preflight passed", body: `${count} device${count === 1 ? "" : "s"} checked in within the last 14 days.` },
    { title: `Receiver job on the ${toLabel} tenant`, body: `<code>POST /endpoint/v1/migrations</code> on <code>${escapeHtml(plan.destApiHost)}</code> with the sending tenant and ${count} device ID${count === 1 ? "" : "s"}.` },
    { title: `Sender trigger on the ${fromLabel} tenant`, body: `<code>${escapeHtml(plan.senderTrigger?.method ?? "PUT")}</code> on <code>${escapeHtml(plan.sourceApiHost)}</code> with the handshake token from the receiver job.` },
    { title: "Live status", body: "The job page polls both tenants every 10 seconds until every device has moved or failed." },
  ];
  document.getElementById("result-area").innerHTML = `
    <div class="plan-box">
      <div class="plan-head">${icon("checkCircle")}<strong>Dry run passed.</strong><span class="hint">Nothing was created. The real run would do this:</span></div>
      <ol class="plan-list">${steps.map((st, i) => `
        <li class="plan-step"><span class="plan-n">${i + 1}</span><div><strong>${st.title}</strong><p>${st.body}</p></div></li>`).join("")}
      </ol>
    </div>`;
}

function showFailures(failures) {
  document.getElementById("result-area").innerHTML = `
    <div class="plan-box is-bad">
      <div class="plan-head">${icon("xCircle")}<strong>Preflight failed for ${failures.length} device${failures.length === 1 ? "" : "s"}.</strong><span class="hint">Nothing was created.</span></div>
      <ul class="plan-list">${failures.map((f) => `
        <li class="plan-step"><span class="plan-n">${icon("x")}</span><div><strong>${escapeHtml(f.hostname || f.endpointId)}</strong><p>${escapeHtml(f.reason)}</p></div></li>`).join("")}
      </ul>
    </div>`;
}

function migrationErrorHint(msg) {
  const m = String(msg);
  if (/migration is not enabled/i.test(m) || (/403/.test(m) && /migration/i.test(m))) {
    return `${escapeHtml(m)}<br/><br/><strong>Fix:</strong> In Sophos Fusion on the <strong>sending</strong> tenant, go to <strong>Overview &gt; Global Settings &gt; Device Migration</strong> and turn on <strong>Allow device migration</strong>. Then retry.`;
  }
  if (/must not match the current tenant/i.test(m)) {
    return `${escapeHtml(m)}<br/><br/><strong>Fix:</strong> The source and destination appear to be the same tenant. Check your credential configuration.`;
  }
  return escapeHtml(m);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
