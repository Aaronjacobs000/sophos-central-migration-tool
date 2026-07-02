import "./nav.js";
import { api } from "./api.js";
import {
  flattenForCompare,
  summarizeEntries,
  renderCompareSummary,
  renderCompareTable,
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
    state.entries = flattenForCompare(
      res.sourcePolicy?.settings ?? {},
      res.destPolicy?.settings ?? {},
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
    ? `Comparing <strong>${escapeHtml(state.sourcePolicy.name)}</strong> on source vs destination`
    : `Source policy <strong>${escapeHtml(state.sourcePolicy.name)}</strong> has no matching destination policy`;
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
        <h2>${escapeHtml(state.sourcePolicy.name)}</h2>
        <div class="compare-meta-row">
          <code>${escapeHtml(state.sourcePolicy.type)}</code>
          ${state.destPolicy ? `<span class="hint">matched by name + type</span>` : `<span class="diff-pill diff-pill-add">no destination match</span>`}
        </div>
      </div>
      <div class="form-actions" style="margin-top:0; display:flex; align-items:center; gap:0.75rem;">
        <button id="clone-btn" class="btn btn-primary">${escapeHtml(cloneLabel)}</button>
      </div>
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
    { key: "priority", label: "Priority" },
    { key: "enforced", label: "Enforced" },
  ];
  const rows = fields
    .map((f) => {
      const sv = src[f.key];
      const dv = dst[f.key];
      const status = state.destPolicy
        ? sv === dv
          ? "match"
          : "differ"
        : "source-only";
      const pillClass = {
        match: "compare-pill-match",
        differ: "compare-pill-differ",
        "source-only": "compare-pill-source",
      }[status];
      const label = { match: "match", differ: "differs", "source-only": "source only" }[status];
      const fmt = (v) => {
        if (v === undefined || v === null) return `<span class="compare-missing">—</span>`;
        return `<code class="compare-value">${escapeHtml(String(v))}</code>`;
      };
      return `
        <tr class="compare-row compare-row-${status}">
          <td class="compare-path">${escapeHtml(f.label)}</td>
          <td class="compare-cell compare-cell-source">${fmt(sv)}</td>
          <td class="compare-cell compare-cell-dest">${state.destPolicy ? fmt(dv) : `<span class="compare-missing">—</span>`}</td>
          <td class="compare-status"><span class="compare-pill ${pillClass}">${label}</span></td>
        </tr>`;
    })
    .join("");

  return `
    <section class="compare-group" style="margin-top:1rem;">
      <header class="compare-group-header">
        <h3>Policy metadata</h3>
        <span class="hint">Top-level policy fields</span>
      </header>
      <table class="data-table compare-table">
        <thead>
          <tr><th>Field</th><th>Source</th><th>Destination</th><th>Status</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
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
    : "clone this policy to destination";
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
