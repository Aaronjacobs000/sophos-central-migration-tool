import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";

// Friendly labels for known Sophos endpoint policy types. Anything not in
// this map falls back to title-casing the raw type slug.
const PRODUCT_LABELS = {
  "threat-protection": "Threat Protection",
  "server-threat-protection": "Server Threat Protection",
  "peripheral-control": "Peripheral Control",
  "application-control": "Application Control",
  "data-loss-prevention": "Data Loss Prevention",
  "web-control": "Web Control",
  "update-management": "Update Management",
  "windows-firewall": "Windows Firewall",
  "endpoint-firewall": "Endpoint Firewall",
  "agent-update": "Agent Update",
  "tamper-protection": "Tamper Protection",
  "device-encryption": "Device Encryption",
  "server-lockdown": "Server Lockdown",
  "exploit-mitigation": "Exploit Mitigation",
  "wireless": "Wireless",
};

const state = {
  source: [],
  dest: [],
  selectedSource: new Set(),
  filter: "",
  hideMatching: false,
  // Deep match data, keyed by `${type}::${name}` (case-sensitive)
  // Values: { status: "match"|"differ"|"source-only"|"dest-only", diffCount }
  matchByKey: new Map(),
  matchStatus: "idle", // "idle" | "loading" | "ready" | "error"
  matchError: null,
};

async function boot() {
  await Promise.all([loadSide("source"), loadSide("dest")]);
  wireToolbar();
  wireBasket();
  render();
  // Kick off the deep policy match in the background. The toggle is disabled
  // until it completes; once ready we re-render with badges.
  loadDeepMatch();
}

async function loadSide(side) {
  try {
    const cached = await getCachedSection(side, "policies");
    if (cached.status?.state === "ok") {
      state[side] = cached.items || [];
      return;
    }
    if (cached.status?.state === "loading") {
      state[side] = { loading: true };
      return;
    }
    if (cached.status?.state === "error") {
      state[side] = { error: cached.status.error };
      return;
    }
    const res = await api.get(`/api/${side}/policies`);
    state[side] = res.items || [];
  } catch (err) {
    state[side] = { error: err.message };
  }
}

async function loadDeepMatch(forceRefresh = false) {
  state.matchStatus = "loading";
  state.matchError = null;
  updateToggleState();
  try {
    const url = forceRefresh
      ? "/api/compare/policies/deep?refresh=true"
      : "/api/compare/policies/deep";
    const res = await api.get(url);
    const map = new Map();
    for (const m of res.matches || []) {
      map.set(`${m.type}::${m.name}`, m);
    }
    state.matchByKey = map;
    state.matchStatus = "ready";
    updateToggleState();
    render();
  } catch (err) {
    state.matchStatus = "error";
    state.matchError = err.message || "Failed to compute deep match";
    updateToggleState();
  }
}

function updateToggleState() {
  const toggle = document.getElementById("hide-matching");
  const note = document.getElementById("hide-matching-note");
  if (!toggle || !note) return;

  if (state.matchStatus === "ready") {
    toggle.disabled = false;
    const total = state.matchByKey.size;
    note.textContent = `(deep match ready · ${total} policies analysed)`;
    note.className = "hint";
  } else if (state.matchStatus === "loading") {
    toggle.disabled = true;
    if (state.hideMatching === false) {
      // toggle is unchecked anyway, just show the loading hint
    }
    note.textContent = "(computing deep match… this can take a moment for tenants with many policies)";
    note.className = "hint";
  } else if (state.matchStatus === "error") {
    toggle.disabled = true;
    note.innerHTML = `(deep match failed: ${escapeHtml(state.matchError ?? "unknown error")} · <a href="#" id="retry-deep">retry</a>)`;
    note.className = "hint banner-err";
    document.getElementById("retry-deep")?.addEventListener("click", (e) => {
      e.preventDefault();
      loadDeepMatch(true);
    });
  } else {
    toggle.disabled = true;
    note.textContent = "";
  }
}

function wireToolbar() {
  document.getElementById("search").addEventListener("input", (e) => {
    state.filter = e.target.value;
    render();
  });
  document.getElementById("hide-matching").addEventListener("change", (e) => {
    state.hideMatching = e.target.checked;
    render();
  });
  document.getElementById("refresh-match").addEventListener("click", () => {
    loadDeepMatch(true);
  });
  document.getElementById("hide-matching").disabled = true;
  updateToggleState();
}

function render() {
  const content = document.getElementById("content");

  // Surface preload errors / loading state explicitly
  if (state.source?.error || state.dest?.error) {
    content.innerHTML = `
      <div class="banner banner-err">
        ${state.source?.error ? `<div><strong>Source:</strong> ${escapeHtml(state.source.error)}</div>` : ""}
        ${state.dest?.error ? `<div><strong>Dest:</strong> ${escapeHtml(state.dest.error)}</div>` : ""}
      </div>
      <button class="btn" id="retry-btn" style="margin-top:0.85rem;">Retry preload</button>
    `;
    document.getElementById("retry-btn").addEventListener("click", async () => {
      content.innerHTML = `<div class="empty-state">Refreshing…</div>`;
      try {
        await Promise.all([
          refreshSection("source", "policies"),
          refreshSection("dest", "policies"),
        ]);
        await Promise.all([loadSide("source"), loadSide("dest")]);
        render();
      } catch (err) {
        toast(err.message || "Refresh failed", "err");
      }
    });
    return;
  }

  if (state.source?.loading || state.dest?.loading) {
    content.innerHTML = `<div class="empty-state">Preload still in progress. The dashboard shows live status.</div>`;
    return;
  }

  const sourcePolicies = Array.isArray(state.source) ? state.source : [];
  const destPolicies = Array.isArray(state.dest) ? state.dest : [];

  if (sourcePolicies.length === 0 && destPolicies.length === 0) {
    content.innerHTML = `<div class="empty-state">No policies found in either tenant.</div>`;
    return;
  }

  const sourceByType = groupByType(sourcePolicies);
  const destByType = groupByType(destPolicies);
  const allTypes = new Set([
    ...Object.keys(sourceByType),
    ...Object.keys(destByType),
  ]);
  const sortedTypes = [...allTypes].sort((a, b) =>
    productLabel(a).localeCompare(productLabel(b)),
  );

  const sections = sortedTypes
    .map((type) => renderProductSection(type, sourceByType[type] ?? [], destByType[type] ?? []))
    .filter((html) => html !== null)
    .join("");

  if (!sections) {
    const reason = state.hideMatching
      ? "All products match between source and destination (deep settings comparison)."
      : "No products match the current filter.";
    content.innerHTML = `<div class="empty-state">${escapeHtml(reason)}</div>`;
    return;
  }

  content.innerHTML = sections;
  wireRows();
  makeSortable(content);
}

function groupByType(policies) {
  const out = {};
  for (const p of policies) {
    const t = p.type || "unknown";
    if (!out[t]) out[t] = [];
    out[t].push(p);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

function productLabel(type) {
  return PRODUCT_LABELS[type] || titleCase(type);
}

function titleCase(slug) {
  return slug
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Look up the deep match record for a given policy. Returns null if the
 * deep match isn't ready yet or this policy isn't in the result.
 */
function lookupMatch(policy) {
  if (state.matchStatus !== "ready") return null;
  return state.matchByKey.get(`${policy.type}::${policy.name}`) ?? null;
}

/**
 * Determine whether a product section is "all matching" by deep comparison.
 * Returns true ONLY when:
 *   - source and dest have exactly the same set of policy (type,name) keys
 *   - every paired policy has status === "match" (zero deep diffs)
 * If the deep match isn't ready, falls back to never hiding (safest).
 */
function productAllMatch(type, srcList, dstList) {
  if (state.matchStatus !== "ready") return false;
  const srcKeys = new Set(srcList.map((p) => p.name));
  const dstKeys = new Set(dstList.map((p) => p.name));
  if (srcKeys.size !== dstKeys.size) return false;
  for (const k of srcKeys) {
    if (!dstKeys.has(k)) return false;
  }
  // Every name-paired policy must have a "match" status
  for (const p of srcList) {
    const m = state.matchByKey.get(`${type}::${p.name}`);
    if (!m || m.status !== "match") return false;
  }
  return true;
}

function renderProductSection(type, srcList, dstList) {
  const q = state.filter.toLowerCase();
  const matches = (p) => !q || p.name.toLowerCase().includes(q);
  const srcFiltered = srcList.filter(matches);
  const dstFiltered = dstList.filter(matches);

  if (q && srcFiltered.length === 0 && dstFiltered.length === 0) return null;

  if (state.hideMatching && productAllMatch(type, srcList, dstList)) {
    return null;
  }

  const srcNames = new Set(srcList.map((p) => p.name.toLowerCase()));
  const dstNames = new Set(dstList.map((p) => p.name.toLowerCase()));

  const label = productLabel(type);

  // Compute a per-product summary using the deep match data when available.
  const productStats = computeProductStats(type, srcList, dstList);
  const productBadge = renderProductBadge(productStats);

  const renderSrcRow = (p) => {
    const inDest = dstNames.has(p.name.toLowerCase());
    const checked = state.selectedSource.has(p.id) ? "checked" : "";
    const matchInfo = lookupMatch(p);
    const statusBadge = renderStatusBadge(matchInfo, inDest);
    const compareBtn = inDest
      ? `<button class="btn btn-small" data-compare="${escapeAttr(p.id)}">Compare</button>`
      : `<button class="btn btn-small btn-primary" data-clone="${escapeAttr(p.id)}">Clone</button>`;
    const enabled = p.enabled === false ? "off" : "on";
    return `
      <tr>
        <td class="col-check"><input type="checkbox" data-id="${escapeAttr(p.id)}" ${checked}/></td>
        <td>
          <a href="/policy-detail.html?side=source&id=${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
          ${statusBadge}
        </td>
        <td><span class="hint">${enabled}</span></td>
        <td class="col-actions">${compareBtn}</td>
      </tr>`;
  };

  const renderDstRow = (p) => {
    const inSource = srcNames.has(p.name.toLowerCase());
    const matchInfo = lookupMatch(p);
    const statusBadge = renderStatusBadge(matchInfo, inSource, "dest");
    const enabled = p.enabled === false ? "off" : "on";
    return `
      <tr>
        <td>
          <a href="/policy-detail.html?side=dest&id=${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
          ${statusBadge}
        </td>
        <td><span class="hint">${enabled}</span></td>
        <td class="col-actions">
          <button class="btn btn-small btn-danger" data-delete-dest="${escapeAttr(p.id)}" data-name="${escapeAttr(p.name)}" title="Delete from destination">Delete</button>
        </td>
      </tr>`;
  };

  const srcTable =
    srcFiltered.length === 0
      ? `<div class="empty-state">No source policies${q ? " match the filter" : ""}.</div>`
      : `<table class="data-table">
           <thead>
             <tr><th class="col-check"></th><th>Name</th><th>Enabled</th><th></th></tr>
           </thead>
           <tbody>${srcFiltered.map(renderSrcRow).join("")}</tbody>
         </table>`;

  const dstTable =
    dstFiltered.length === 0
      ? `<div class="empty-state">No destination policies${q ? " match the filter" : ""}.</div>`
      : `<table class="data-table">
           <thead>
             <tr><th>Name</th><th>Enabled</th><th></th></tr>
           </thead>
           <tbody>${dstFiltered.map(renderDstRow).join("")}</tbody>
         </table>`;

  return `
    <section class="panel-card product-section">
      <header class="product-header">
        <h2>${escapeHtml(label)}</h2>
        <code class="product-type-tag">${escapeHtml(type)}</code>
        ${productBadge}
        <span class="spacer"></span>
        <span class="hint">${srcList.length} source · ${dstList.length} dest</span>
      </header>
      <div class="product-split">
        <div class="product-side">
          <div class="product-side-label">Source</div>
          ${srcTable}
        </div>
        <div class="product-side">
          <div class="product-side-label">Destination</div>
          ${dstTable}
        </div>
      </div>
    </section>
  `;
}

function computeProductStats(type, srcList, dstList) {
  if (state.matchStatus !== "ready") return null;
  const stats = { match: 0, differ: 0, sourceOnly: 0, destOnly: 0, total: 0 };
  const seen = new Set();
  for (const p of srcList) {
    const m = state.matchByKey.get(`${type}::${p.name}`);
    if (!m) continue;
    seen.add(`${type}::${p.name}`);
    stats.total++;
    if (m.status === "match") stats.match++;
    else if (m.status === "differ") stats.differ++;
    else if (m.status === "source-only") stats.sourceOnly++;
  }
  for (const p of dstList) {
    const k = `${type}::${p.name}`;
    if (seen.has(k)) continue;
    const m = state.matchByKey.get(k);
    if (!m) continue;
    stats.total++;
    if (m.status === "dest-only") stats.destOnly++;
  }
  return stats;
}

function renderProductBadge(stats) {
  if (!stats || stats.total === 0) return "";
  const parts = [];
  if (stats.differ) parts.push(`<span class="diff-pill diff-pill-change">${stats.differ} differ</span>`);
  if (stats.sourceOnly) parts.push(`<span class="diff-pill diff-pill-add">${stats.sourceOnly} source only</span>`);
  if (stats.destOnly) parts.push(`<span class="diff-pill diff-pill-remove">${stats.destOnly} dest only</span>`);
  if (parts.length === 0 && stats.match > 0) {
    parts.push(`<span class="diff-pill diff-pill-add" style="background:rgba(92,194,107,0.12); color:var(--status-ok); border-color:rgba(92,194,107,0.3);">all ${stats.match} match</span>`);
  }
  return parts.join(" ");
}

function renderStatusBadge(matchInfo, hasCounterpart, side = "source") {
  if (state.matchStatus !== "ready") return "";
  if (!matchInfo) return "";

  const style = "margin-left:0.4rem;";
  if (matchInfo.status === "match") {
    return `<span class="diff-pill diff-pill-add" style="${style} background:rgba(92,194,107,0.12); color:var(--status-ok); border-color:rgba(92,194,107,0.3);" title="settings match">✓ match</span>`;
  }
  if (matchInfo.status === "differ") {
    const count = matchInfo.diffCount > 0 ? `${matchInfo.diffCount} change${matchInfo.diffCount === 1 ? "" : "s"}` : "differs";
    return `<span class="diff-pill diff-pill-change" style="${style}" title="settings differ">${escapeHtml(count)}</span>`;
  }
  if (matchInfo.status === "source-only") {
    if (side === "source") {
      return `<span class="diff-pill diff-pill-add" style="${style}">only source</span>`;
    }
    return "";
  }
  if (matchInfo.status === "dest-only") {
    if (side === "dest") {
      return `<span class="diff-pill diff-pill-remove" style="${style}">only dest</span>`;
    }
    return "";
  }
  return "";
}

function wireRows() {
  document.querySelectorAll('input[type="checkbox"][data-id]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) state.selectedSource.add(id);
      else state.selectedSource.delete(id);
      renderBasket();
    });
  });
  document.querySelectorAll("[data-compare]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.target.dataset.compare;
      window.location.href = `/policy-compare.html?sourceId=${encodeURIComponent(id)}`;
    });
  });
  document.querySelectorAll("[data-clone]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.dataset.clone;
      if (!confirm("Clone this policy to destination?")) return;
      try {
        const res = await api.post("/api/migrate/policies", { policyIds: [id] });
        const ok = res.results?.filter((r) => r.ok).length ?? 0;
        const failed = res.results?.filter((r) => !r.ok).length ?? 0;
        toast(`Cloned ${ok} / failed ${failed}`, failed ? "err" : "ok");
        await refreshSection("dest", "policies").catch(() => {});
        await loadSide("dest");
        loadDeepMatch(true);
        render();
      } catch (err) {
        toast(err.message || "Clone failed", "err");
      }
    });
  });
  document.querySelectorAll("[data-delete-dest]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.dataset.deleteDest;
      const name = e.target.dataset.name;
      if (!confirm(`Delete the destination policy "${name}"?\n\nThis action is irreversible.`)) return;
      // Second confirmation for destructive ops
      if (!confirm(`Are you absolutely sure? "${name}" will be permanently removed from the destination tenant.`)) return;
      try {
        await api.del(`/api/dest/policies/${encodeURIComponent(id)}`);
        toast(`Deleted "${name}" from destination.`, "ok");
        await refreshSection("dest", "policies").catch(() => {});
        await loadSide("dest");
        loadDeepMatch(true);
        render();
      } catch (err) {
        toast(err.message || "Delete failed", "err");
      }
    });
  });
}

function renderBasket() {
  const basket = document.getElementById("selection-basket");
  document.getElementById("basket-count").textContent = String(state.selectedSource.size);
  basket.classList.toggle("hidden", state.selectedSource.size === 0);
}

function wireBasket() {
  document.getElementById("basket-compare").addEventListener("click", () => {
    if (state.selectedSource.size !== 1) {
      toast("Select exactly one source policy to compare.", "info");
      return;
    }
    const [id] = state.selectedSource;
    window.location.href = `/policy-compare.html?sourceId=${encodeURIComponent(id)}`;
  });

  document.getElementById("basket-clone").addEventListener("click", async () => {
    const ids = Array.from(state.selectedSource);
    if (ids.length === 0) return;
    if (!confirm(`Clone ${ids.length} polic${ids.length === 1 ? "y" : "ies"} from source to destination?`)) return;
    try {
      const res = await api.post("/api/migrate/policies", { policyIds: ids });
      const ok = res.results?.filter((r) => r.ok).length ?? 0;
      const failed = res.results?.filter((r) => !r.ok).length ?? 0;
      toast(`Cloned ${ok} / failed ${failed}`, failed ? "err" : "ok");
      state.selectedSource.clear();
      renderBasket();
      await refreshSection("dest", "policies").catch(() => {});
      await loadSide("dest");
      loadDeepMatch(true);
      render();
    } catch (err) {
      toast(err.message || "Clone failed", "err");
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

boot();
