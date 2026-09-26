import "./nav.js";
import { api } from "./api.js";
import {
  flattenForCompare,
  summarizeEntries,
  renderCompareSummary,
  renderCompareTable,
  renderValue,
} from "./diff-view.js";
import { toast } from "./toast.js";

const state = {
  sourcePolicy: null,
  destPolicy: null,
  entries: [],
  showOnlyDiffs: true,
  filter: "",
};

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const sourceId = params.get("sourceId");
  const destId = params.get("destId");
  if (!sourceId) {
    document.getElementById("header-area").innerHTML =
      `<div class="banner banner-err">Missing sourceId.</div>`;
    return;
  }

  const url = destId
    ? `/api/compare/policies/${encodeURIComponent(sourceId)}/${encodeURIComponent(destId)}`
    : `/api/compare/policies/${encodeURIComponent(sourceId)}`;

  try {
    const res = await api.get(url);
    state.sourcePolicy = res.sourcePolicy;
    state.destPolicy = res.destPolicy;
    // The server's copy of the settings names web profiles instead of each tenant's ID for them.
    state.entries = flattenForCompare(
      res.settings?.source ?? res.sourcePolicy?.settings ?? {},
      res.settings?.dest ?? res.destPolicy?.settings ?? {},
    );
    renderHeader();
    renderBody();
    wireToolbar();
  } catch (err) {
    document.getElementById("header-area").innerHTML =
      `<div class="banner banner-err">${escapeHtml(err.message || "Failed to compare")}</div>`;
  }
}

function renderHeader() {
  const lead = state.destPolicy
    ? `Comparing <strong>${escapeHtml(state.sourcePolicy.name)}</strong> on the source and the destination.`
    : `Source policy <strong>${escapeHtml(state.sourcePolicy.name)}</strong> has no matching destination policy.`;
  document.getElementById("page-lead").innerHTML = lead;

  const summary = summarizeEntries(state.entries);
  const summaryHtml = state.destPolicy ? renderCompareSummary(summary) : "";

  // Metadata diff (enabled, priority, enforced)
  const metaRows = renderMetadataRows();

  const cloneLabel = state.destPolicy
    ? "Overwrite destination with source"
    : "Clone to destination";

  document.getElementById("header-area").innerHTML = `
    <header class="compare-page-header">
      <div>
        <h2 class="compare-title">${escapeHtml(state.sourcePolicy.name)}</h2>
        <div class="compare-meta-row">
          <code>${escapeHtml(state.sourcePolicy.type)}</code>
          ${state.destPolicy ? `<span class="hint">Matched by name and type</span>` : `<span class="tag tag-src">No destination match</span>`}
        </div>
      </div>
      <button id="clone-btn" class="btn btn-primary">${escapeHtml(cloneLabel)}</button>
    </header>
    ${summaryHtml}
    ${metaRows}
  `;

  document.getElementById("clone-btn").addEventListener("click", cloneToDest);

  // Show the compare card if we have a destination to compare against
  if (state.destPolicy) {
    document.getElementById("compare-card").hidden = false;
  }
}

function renderMetadataRows() {
  const src = state.sourcePolicy ?? {};
  const dst = state.destPolicy ?? {};
  const fields = [
    { key: "enabled", label: "Enabled" },
    // Not compared: a clone goes to the bottom of the destination's order,
    // so its priority differs by design (the deep match skips it too).
    { key: "priority", label: "Priority", compare: false },
    { key: "enforced", label: "Enforced" },
  ];
  const rows = fields
    .map((f) => {
      const sv = src[f.key];
      const dv = dst[f.key];
      const status = !state.destPolicy
        ? "source-only"
        : f.compare === false
          ? "not-compared"
          : sv === dv
            ? "match"
            : "differ";
      const pillClass = {
        match: "tag-ok",
        differ: "tag-warn",
        "source-only": "tag-src",
        "not-compared": "tag-muted",
      }[status];
      const label = { match: "match", differ: "differs", "source-only": "source only", "not-compared": "not compared" }[status];
      const role = status === "differ";
      return `
        <tr class="compare-row compare-row-${status}">
          <td class="compare-path"><span class="set-label">${escapeHtml(f.label)}</span></td>
          <td class="compare-cell">${renderValue(sv ?? undefined, false, role ? "before" : "")}</td>
          <td class="compare-cell">${state.destPolicy ? renderValue(dv ?? undefined, false, role ? "after" : "") : `<span class="compare-missing">not set</span>`}</td>
          <td class="compare-status"><span class="tag ${pillClass}">${label}</span></td>
        </tr>`;
    })
    .join("");

  return `
    <table class="data-table compare-table compare-meta">
      <thead>
        <tr><th>Policy field</th><th><span class="side-title">Source</span></th><th><span class="side-title is-dest">Destination</span></th><th>Status</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderBody() {
  if (!state.destPolicy) {
    document.getElementById("compare-body").innerHTML = "";
    return;
  }
  const html = renderCompareTable(state.entries, {
    showOnlyDiffs: state.showOnlyDiffs,
    filter: state.filter,
  });
  document.getElementById("compare-body").innerHTML = html;
}

function wireToolbar() {
  document.getElementById("show-only-diffs").addEventListener("change", (e) => {
    state.showOnlyDiffs = e.target.checked;
    renderBody();
  });
  document.getElementById("filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderBody();
  });
}

async function cloneToDest() {
  const verb = state.destPolicy
    ? "overwrite the destination policy with source"
    : "clone this policy to the bottom of the destination's priority order";
  if (!confirm(`Are you sure you want to ${verb}?`)) return;
  try {
    const res = await api.post("/api/migrate/policies", {
      policyIds: [state.sourcePolicy.id],
      overwrite: !!state.destPolicy,
    });
    const ok = res.results?.filter((r) => r.ok).length ?? 0;
    let suffix = "";
    const adjustments = res.results?.[0]?.adjustments;
    if (adjustments?.length) {
      suffix += ` ${adjustments.length} setting${adjustments.length === 1 ? "" : "s"} adjusted for destination.`;
    }
    if (ok > 0) {
      toast(`Policy migrated.${suffix} Re-running compare…`, "ok");
      // Re-fetch the comparison so the user sees the new state
      setTimeout(() => window.location.reload(), 800);
    } else {
      const err = res.results?.[0]?.error ?? "Unknown error";
      toast(`Migration failed: ${err}`, "err");
    }
  } catch (err) {
    toast(err.message || "Migration failed", "err");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
