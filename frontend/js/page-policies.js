import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";
import { icon } from "./icons.js";
import { rowMenu, wireRowMenus, stackBar } from "./ui.js";

// Friendly labels for known Sophos endpoint policy types. Anything not in
// this map falls back to title-casing the raw type slug.
const PRODUCT_LABELS = {
  "threat-protection": "Threat Protection",
  "server-threat-protection": "Server Threat Protection",
  "peripheral-control": "Peripheral Control",
  "server-peripheral-control": "Server Peripheral Control",
  "application-control": "Application Control",
  "server-application-control": "Server Application Control",
  "server-web-control": "Server Web Control",
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

// Policy types whose `appliesTo` assignments are exported, mirroring
// scripts/export-policy-assignments.mjs. Server policies are distinct types
// in the API, so both the endpoint and server variants are included.
const ASSIGNMENT_POLICY_TYPES = [
  "peripheral-control",
  "application-control",
  "server-peripheral-control",
  "server-application-control",
];

// CSV columns, identical to the standalone export script.
const ASSIGNMENT_CSV_HEADER = [
  "policy_name", "policy_type", "enabled", "priority",
  "assignee_kind", "assignee_name", "assignee_id",
];

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
    note.textContent = `Deep match ready, ${total} policies compared`;
    note.className = "hint";
  } else if (state.matchStatus === "loading") {
    toggle.disabled = true;
    if (state.hideMatching === false) {
      // toggle is unchecked anyway, just show the loading hint
    }
    note.innerHTML = `<span class="spin"></span> Comparing settings on both sides, this can take a moment`;
    note.className = "hint";
  } else if (state.matchStatus === "error") {
    toggle.disabled = true;
    note.innerHTML = `Deep match failed: ${escapeHtml(state.matchError ?? "unknown error")}. <a href="#" id="retry-deep">Retry</a>`;
    note.className = "hint is-bad";
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
  document.getElementById("export-assignments").addEventListener("click", exportAssignments);
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
      <button class="btn mt" id="retry-btn">Retry preload</button>
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
    content.innerHTML = `<div class="empty-state">Preload is still running. The dashboard shows live status.</div>`;
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

  // Per-product summary from the deep match, when it is ready.
  const productStats = computeProductStats(type, srcList, dstList);
  const productBadge = renderProductBadge(productStats);

  const renderSrcRow = (p) => {
    const inDest = dstNames.has(p.name.toLowerCase());
    const checked = state.selectedSource.has(p.id) ? "checked" : "";
    const matchInfo = lookupMatch(p);
    const statusBadge = renderStatusBadge(matchInfo, inDest);
    const action = inDest
      ? `<button class="btn btn-small" data-compare="${escapeAttr(p.id)}">Compare</button>`
      : `<button class="btn btn-small btn-primary" data-clone="${escapeAttr(p.id)}">Clone</button>`;
    return `
      <tr${checked ? ' class="selected"' : ""}>
        <td class="col-check"><input type="checkbox" data-id="${escapeAttr(p.id)}" ${checked} aria-label="Select ${escapeAttr(p.name)}"/></td>
        <td class="cell-name">
          <a href="/policy-detail.html?side=source&id=${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
          ${statusBadge}
        </td>
        <td class="cell-state">${enabledCell(p)}</td>
        <td class="col-actions">${action}</td>
      </tr>`;
  };

  const renderDstRow = (p) => {
    const inSource = srcNames.has(p.name.toLowerCase());
    const matchInfo = lookupMatch(p);
    const statusBadge = renderStatusBadge(matchInfo, inSource, "dest");
    const menu = rowMenu([
      { label: "Delete from destination", icon: "trash", danger: true, attrs: `data-delete-dest="${escapeAttr(p.id)}" data-name="${escapeAttr(p.name)}"` },
    ]);
    return `
      <tr>
        <td class="cell-name">
          <a href="/policy-detail.html?side=dest&id=${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
          ${statusBadge}
        </td>
        <td class="cell-state">${enabledCell(p)}</td>
        <td class="col-actions">${menu}</td>
      </tr>`;
  };

  const srcTable =
    srcFiltered.length === 0
      ? `<div class="empty-state">No source policies${q ? " match the filter" : ""}.</div>`
      : `<table class="data-table">
           <thead>
             <tr><th class="col-check"></th><th>Name</th><th>State</th><th class="col-actions"></th></tr>
           </thead>
           <tbody>${srcFiltered.map(renderSrcRow).join("")}</tbody>
         </table>`;

  const dstTable =
    dstFiltered.length === 0
      ? `<div class="empty-state">No destination policies${q ? " match the filter" : ""}.</div>`
      : `<table class="data-table">
           <thead>
             <tr><th>Name</th><th>State</th><th class="col-actions"></th></tr>
           </thead>
           <tbody>${dstFiltered.map(renderDstRow).join("")}</tbody>
         </table>`;

  return `
    <section class="panel-card product-section">
      <header class="product-header">
        <h2>${escapeHtml(label)}</h2>
        <code class="product-type-tag">${escapeHtml(type)}</code>
        <span class="spacer"></span>
        <span class="hint tnum">${srcList.length} source · ${dstList.length} destination</span>
      </header>
      ${productBadge}
      <div class="product-split">
        <div class="product-side">
          <div class="product-side-label side-title">Source</div>
          ${srcTable}
        </div>
        <div class="product-side">
          <div class="product-side-label side-title is-dest">Destination</div>
          ${dstTable}
        </div>
      </div>
    </section>
  `;
}

function enabledCell(p) {
  return p.enabled === false
    ? `<span class="tag tag-muted">Off</span>`
    : `<span class="hint">On</span>`;
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
  if (!stats || stats.total === 0) {
    return `<div class="product-bar is-pending">${state.matchStatus === "loading" ? `<span class="hint"><span class="spin"></span> Comparing</span>` : ""}</div>`;
  }
  const item = (n, cls, text) => (n ? `<span class="${cls}"><i></i><b>${n}</b> ${text}</span>` : "");
  return `
    <div class="product-bar">
      ${stackBar(stats)}
      <span class="legend">
        ${item(stats.match, "l-match", "match")}
        ${item(stats.differ, "l-differ", "differ")}
        ${item(stats.sourceOnly, "l-src", "source only")}
        ${item(stats.destOnly, "l-dst", "destination only")}
      </span>
    </div>`;
}

function renderStatusBadge(matchInfo, hasCounterpart, side = "source") {
  if (state.matchStatus !== "ready") return "";
  if (!matchInfo) return "";

  if (matchInfo.status === "match") {
    return `<span class="tag tag-ok" title="Settings match">${icon("check")}match</span>`;
  }
  if (matchInfo.status === "differ") {
    const count = matchInfo.diffCount > 0 ? `${matchInfo.diffCount} change${matchInfo.diffCount === 1 ? "" : "s"}` : "differs";
    return `<span class="tag tag-warn" title="Settings differ">${escapeHtml(count)}</span>`;
  }
  if (matchInfo.status === "source-only") {
    return side === "source" ? `<span class="tag tag-src">source only</span>` : "";
  }
  if (matchInfo.status === "dest-only") {
    return side === "dest" ? `<span class="tag tag-dst">destination only</span>` : "";
  }
  return "";
}

function wireRows() {
  wireRowMenus(document.getElementById("content"));
  document.querySelectorAll('input[type="checkbox"][data-id]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) state.selectedSource.add(id);
      else state.selectedSource.delete(id);
      e.target.closest("tr")?.classList.toggle("selected", e.target.checked);
      renderBasket();
    });
  });
  document.querySelectorAll("[data-compare]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.dataset.compare;
      window.location.href = `/policy-compare.html?sourceId=${encodeURIComponent(id)}`;
    });
  });
  document.querySelectorAll("[data-clone]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.clone;
      if (!confirm("Clone this policy to destination?")) return;
      try {
        const res = await api.post("/api/migrate/policies", {
          policyIds: [id],
        });
        const ok = res.results?.filter((r) => r.ok).length ?? 0;
        const failed = res.results?.filter((r) => !r.ok).length ?? 0;
        toast(`Cloned ${ok} / failed ${failed}${summarizeAssignments(res.results)}`, failed ? "err" : "ok");
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
      const id = e.currentTarget.dataset.deleteDest;
      const name = e.currentTarget.dataset.name;
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
      const res = await api.post("/api/migrate/policies", {
        policyIds: ids,
      });
      const ok = res.results?.filter((r) => r.ok).length ?? 0;
      const failed = res.results?.filter((r) => !r.ok).length ?? 0;
      toast(`Cloned ${ok} / failed ${failed}${summarizeAssignments(res.results)}`, failed ? "err" : "ok");
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

/**
 * Build a short " · assignments: N mapped, M skipped" suffix from migration
 * results. Returns "" when assignment migration wasn't requested (no policy
 * result carries an `assignments` report).
 */
function summarizeAssignments(results) {
  // Settings the migrator changed/dropped to fit the destination (full detail
  // is in the API response and the audit log).
  const adjusted = (results ?? []).flatMap((r) => r.adjustments ?? []);
  if (adjusted.length === 0) return "";
  return ` · ${adjusted.length} setting${adjusted.length === 1 ? "" : "s"} adjusted for destination`;
}

/**
 * Export Peripheral Control + Application Control policy assignments (source
 * tenant) to a CSV download. Mirrors scripts/export-policy-assignments.mjs:
 * for each policy it expands `appliesTo` into one row per assigned user, user
 * group, endpoint or endpoint group (or a single "none" row when unassigned),
 * resolving IDs to names. Source policies are already loaded in state.source.
 */
async function exportAssignments() {
  const btn = document.getElementById("export-assignments");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Building CSV";
  try {
    const sourcePolicies = Array.isArray(state.source) ? state.source : [];
    const policies = sourcePolicies.filter((p) =>
      ASSIGNMENT_POLICY_TYPES.includes(p.type),
    );
    if (policies.length === 0) {
      toast("No Peripheral Control or Application Control policies on the source tenant.", "info");
      return;
    }

    const resolve = await buildAssignmentNameResolver();

    const rows = [ASSIGNMENT_CSV_HEADER];
    for (const p of policies) {
      const a = p.appliesTo ?? {};
      const groups = [
        ["user", a.users],
        ["user_group", a.userGroups],
        ["endpoint", a.endpoints],
        ["endpoint_group", a.endpointGroups],
      ];
      let any = false;
      for (const [kind, list] of groups) {
        for (const ref of list ?? []) {
          any = true;
          // The API returns refs as plain UUID strings; tolerate `{ id }` too.
          const refId = typeof ref === "string" ? ref : ref.id;
          rows.push([p.name, p.type, p.enabled ?? "", p.priority ?? "", kind, resolve(refId), refId]);
        }
      }
      if (!any) {
        rows.push([p.name, p.type, p.enabled ?? "", p.priority ?? "", "none", "", ""]);
      }
    }

    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
    downloadCsv(csv, "policy-assignments.csv");
    const policyWord = policies.length === 1 ? "policy" : "policies";
    toast(`Exported ${policies.length} ${policyWord} to policy-assignments.csv`, "ok");
  } catch (err) {
    toast(err.message || "Export failed", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * Build an id -> name resolver for assignment targets on the source tenant.
 * Reuses the preload cache for endpoints and endpoint groups; user groups and
 * directory users are fetched on demand (not preloaded). Any source that fails
 * to load is skipped; unresolved IDs fall back to the raw ID.
 */
async function buildAssignmentNameResolver() {
  const [endpoints, endpointGroups, userGroups, users] = await Promise.all([
    loadResolverItems("endpoints", "/api/source/endpoints"),
    loadResolverItems("groups", "/api/source/groups"),
    fetchResolverItems("/api/source/user-groups"),
    fetchResolverItems("/api/source/users"),
  ]);

  const nameMap = new Map();
  for (const u of users) nameMap.set(u.id, u.name ?? u.email ?? u.id);
  for (const g of userGroups) nameMap.set(g.id, g.name ?? g.id);
  for (const e of endpoints) nameMap.set(e.id, e.hostname ?? e.id);
  for (const g of endpointGroups) nameMap.set(g.id, g.name ?? g.id);

  return (id) => nameMap.get(id) ?? id;
}

// Prefer preloaded data for a section; fall back to a direct API fetch.
async function loadResolverItems(section, fallbackPath) {
  try {
    const cached = await getCachedSection("source", section);
    if (cached.status?.state === "ok") return cached.items || [];
  } catch {
    // Fall through to the direct fetch below.
  }
  return fetchResolverItems(fallbackPath);
}

async function fetchResolverItems(path) {
  try {
    const res = await api.get(path);
    return res.items || [];
  } catch {
    return [];
  }
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

boot();
