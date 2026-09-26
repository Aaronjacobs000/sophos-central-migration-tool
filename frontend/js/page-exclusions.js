import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";
import { rowMenu, wireRowMenus, plural, resultsModal, outcomeOf, onDestCell, ON_DEST_HEADER } from "./ui.js";

// The first three types come from the preload cache and can be deleted on
// the destination. The rest are read on demand and are copy only.
const TABS = [
  { id: "scanning", section: "scanning-exclusions", label: "scanning exclusion" },
  { id: "allowed-items", section: "allowed-items", label: "allowed item" },
  { id: "blocked-items", section: "blocked-items", label: "blocked item" },
  { id: "isolation", section: null, label: "isolation exclusion" },
  { id: "intrusion-prevention", section: null, label: "intrusion prevention exclusion" },
  { id: "exploit-mitigation", section: null, label: "exploit mitigation application" },
  { id: "local-sites", section: null, label: "website" },
  { id: "tls-excluded-websites", section: null, label: "TLS decryption exclusion" },
];
const LEGACY = new Set(["scanning", "allowed-items", "blocked-items"]);
const NOTES = {
  isolation: "Addresses that stay reachable while a device is isolated.",
  "intrusion-prevention": "Traffic that intrusion prevention does not inspect.",
  "exploit-mitigation": "Custom applications only. Detected applications are found by the agent on each tenant and are not copied.",
  "local-sites": "Website Management entries. Copy these before cloning web control policies, because policies refer to their tags.",
  "tls-excluded-websites": "Websites excluded from SSL/TLS decryption.",
};
const state = {
  activeTab: "scanning",
  data: Object.fromEntries(TABS.map((t) => [t.id, { source: [], dest: [] }])),
  selectedSource: new Set(), // keyed by `${type}::${id}`
};

// Websites excluded from TLS decryption have no ID; the value identifies them.
function idOf(type, item) {
  return type === "tls-excluded-websites" ? String(item.value ?? "") : String(item.id ?? "");
}

function splitKey(key) {
  const i = key.indexOf("::");
  return [key.slice(0, i), key.slice(i + 2)];
}

async function boot() {
  wireTabs();
  wireBasket();
  wireSelectAll();
  await Promise.all(TABS.flatMap((t) => [loadSide("source", t), loadSide("dest", t)]));
  renderActive();
}

function wireSelectAll() {
  document.getElementById("select-all-source").addEventListener("click", () => {
    const type = state.activeTab;
    const data = state.data[type].source;
    if (!Array.isArray(data)) return;
    for (const it of data) state.selectedSource.add(`${type}::${idOf(type, it)}`);
    renderActive();
    renderBasket();
    const tab = TABS.find((t) => t.id === type);
    toast(`Selected ${plural(data.length, tab.label)}.`, "ok");
  });
  document.getElementById("clear-source").addEventListener("click", () => {
    // Clear only items in the active tab
    const type = state.activeTab;
    for (const key of [...state.selectedSource]) {
      if (key.startsWith(`${type}::`)) state.selectedSource.delete(key);
    }
    renderActive();
    renderBasket();
  });
}

async function loadSide(side, tab) {
  if (!tab.section) {
    try {
      const res = await api.get(`/api/${side}/exclusions/${tab.id}`);
      state.data[tab.id][side] = res.items || [];
    } catch (err) {
      state.data[tab.id][side] = { error: err.message };
    }
    return;
  }
  try {
    const cached = await getCachedSection(side, tab.section);
    if (cached.status?.state === "ok") {
      state.data[tab.id][side] = cached.items || [];
      return;
    }
    if (cached.status?.state === "error") {
      state.data[tab.id][side] = { error: cached.status.error };
      return;
    }
    if (cached.status?.state === "loading") {
      state.data[tab.id][side] = { loading: true };
      return;
    }
    // idle - fall back to direct fetch
    const path = tab.id === "scanning" ? "scanning" : tab.id;
    const res = await api.get(`/api/${side}/exclusions/${path}`);
    state.data[tab.id][side] = res.items || [];
  } catch (err) {
    state.data[tab.id][side] = { error: err.message };
  }
}

function renderActive() {
  renderTable("source");
  renderTable("dest");
  for (const t of TABS) {
    const el = document.querySelector(`[data-count="${t.id}"]`);
    const items = state.data[t.id].source;
    if (el) el.textContent = Array.isArray(items) ? String(items.length) : "";
  }
}

// Same identity the server's duplicate check uses, so dimming matches what a copy would skip.
function keyFor(type, item) {
  const sorted = (list) => (Array.isArray(list) ? list.map((x) => String(x).toLowerCase()).sort().join(",") : "");
  switch (type) {
    case "isolation":
    case "intrusion-prevention":
      return [String(item.direction ?? "").toLowerCase(), sorted(item.remoteAddresses), sorted(item.localPorts), sorted(item.remotePorts)].join("|");
    case "exploit-mitigation":
      return sorted(item.paths);
    case "local-sites":
      return String(item.url ?? "").trim().toLowerCase();
    case "tls-excluded-websites":
      return String(item.value ?? "").trim().toLowerCase();
    default:
      return itemKey(item);
  }
}

// Column layout per type: header labels and the cells for one item.
function columnsFor(type) {
  const list = (v) => (Array.isArray(v) && v.length ? v.join(", ") : "any");
  switch (type) {
    case "isolation":
    case "intrusion-prevention":
      return {
        head: ["Direction", "Remote address", "Ports", "Comment"],
        cells: (it) => [
          `<span class="tag tag-muted">${escapeHtml(it.direction || "")}</span>`,
          `<span class="mono-cell">${escapeHtml(list(it.remoteAddresses))}</span>`,
          `<span class="hint">local ${escapeHtml(list(it.localPorts))} · remote ${escapeHtml(list(it.remotePorts))}</span>`,
          `<span class="hint">${escapeHtml(it.comment || "")}</span>`,
        ],
      };
    case "exploit-mitigation":
      return {
        head: ["Application", "Path"],
        cells: (it) => [
          `<span class="cell-name">${escapeHtml(it.name || "")}</span>`,
          `<span class="mono-cell">${escapeHtml((it.paths || []).join(", "))}</span>`,
        ],
      };
    case "local-sites":
      return {
        head: ["Website", "Tags or category", "Comment"],
        cells: (it) => [
          `<span class="mono-cell">${escapeHtml(it.url || "")}</span>`,
          (it.tags || []).length
            ? it.tags.map((t) => `<span class="tag tag-muted">${escapeHtml(t)}</span>`).join(" ")
            : it.categoryId != null ? `<span class="hint">category ${escapeHtml(String(it.categoryId))}</span>` : "",
          `<span class="hint">${escapeHtml(it.comment || "")}</span>`,
        ],
      };
    case "tls-excluded-websites":
      return {
        head: ["Website", "Comment"],
        cells: (it) => [
          `<span class="mono-cell">${escapeHtml(it.value || "")}</span>`,
          `<span class="hint">${escapeHtml(it.comment || "")}</span>`,
        ],
      };
    default:
      return {
        head: ["Kind", "Value", "Comment"],
        cells: (it) => [
          `<span class="tag tag-muted">${escapeHtml(it.type || "")}</span>`,
          `<span class="mono-cell">${type === "scanning" ? escapeHtml(it.value || "") : escapeHtml(formatItemValue(it))}</span>`,
          `<span class="hint">${escapeHtml(it.comment || "")}</span>`,
        ],
      };
  }
}

function itemKey(item) {
  if (item.value !== undefined) return `${item.type}::${item.value}`;
  if (item.properties !== undefined) return `${item.type}::${stableStringify(item.properties)}`;
  return `${item.type}::${item.id}`;
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

function renderTable(side) {
  const type = state.activeTab;
  const data = state.data[type][side];
  const target = document.getElementById(`table-${side}`);
  if (data && data.error) {
    target.innerHTML = `<div class="banner banner-err">${escapeHtml(data.error)}</div>`;
    return;
  }
  if (data && data.loading) {
    target.innerHTML = `<div class="empty-state">Preload is still running.</div>`;
    return;
  }
  const items = Array.isArray(data) ? data : [];
  const note = side === "source" && NOTES[type] ? `<p class="hint tab-note">${escapeHtml(NOTES[type])}</p>` : "";
  if (items.length === 0) {
    target.innerHTML = `${note}<div class="empty-state">No items.</div>`;
    return;
  }
  const other = state.data[type][side === "source" ? "dest" : "source"];
  const otherKeys = new Set(Array.isArray(other) ? other.map((x) => keyFor(type, x)) : []);
  const cols = columnsFor(type);
  const canDelete = LEGACY.has(type);
  const rows = items
    .map((it) => {
      const id = idOf(type, it);
      const checked = side === "source" && state.selectedSource.has(`${type}::${id}`) ? "checked" : "";
      const onBoth = otherKeys.has(keyFor(type, it));
      const checkbox = side === "source"
        ? `<td class="col-check"><input type="checkbox" data-id="${escapeAttr(id)}" ${checked} aria-label="Select item"/></td>${onDestCell(onBoth)}`
        : "";
      const actionCell = side === "dest" && canDelete
        ? `<td class="col-actions">${rowMenu([{ label: "Delete from destination", icon: "trash", danger: true, attrs: `data-delete-dest="${escapeAttr(it.id)}" data-display="${escapeAttr(typeof it.value === "string" ? it.value : formatItemValue(it))}"` }])}</td>`
        : "";
      const cls = [onBoth ? "is-dim" : "", checked ? "selected" : ""].filter(Boolean).join(" ");
      return `
        <tr${cls ? ` class="${cls}"` : ""}${onBoth ? ' title="Exists on both sides"' : ""}>
          ${checkbox}
          ${cols.cells(it).map((c) => `<td>${c}</td>`).join("")}
          ${actionCell}
        </tr>`;
    })
    .join("");
  const headerExtra = side === "dest" && canDelete ? `<th class="col-actions"></th>` : "";
  const checkHeader = side === "source" ? `<th class="col-check"></th>${ON_DEST_HEADER}` : "";
  target.innerHTML = `
    ${note}
    <table class="data-table">
      <thead>
        <tr>${checkHeader}${cols.head.map((h) => `<th>${h}</th>`).join("")}${headerExtra}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(target);
  wireRowMenus(target);
  if (side === "source") {
    target.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const key = `${type}::${e.target.dataset.id}`;
        if (e.target.checked) state.selectedSource.add(key);
        else state.selectedSource.delete(key);
        e.target.closest("tr")?.classList.toggle("selected", e.target.checked);
        renderBasket();
      });
    });
  }
  if (side === "dest") {
    target.querySelectorAll("[data-delete-dest]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.currentTarget.dataset.deleteDest;
        const display = e.currentTarget.dataset.display;
        const apiPath = type === "scanning" ? "scanning" : type;
        if (!confirm(`Delete this ${type} item from destination?\n\n${display}\n\nThis action is irreversible.`)) return;
        if (!confirm(`Are you absolutely sure? This item will be permanently removed.`)) return;
        try {
          await api.del(`/api/dest/exclusions/${apiPath}/${encodeURIComponent(id)}`);
          toast("Deleted from destination.", "ok");
          // Refresh the dest cache for this section so it disappears from the table
          const sectionMap = { scanning: "scanning-exclusions", "allowed-items": "allowed-items", "blocked-items": "blocked-items" };
          await refreshSection("dest", sectionMap[type]).catch(() => {});
          const tab = TABS.find((t) => t.id === type);
          if (tab) await loadSide("dest", tab);
          renderActive();
        } catch (err) {
          toast(err.message || "Delete failed", "err");
        }
      });
    });
  }
}

function formatItemValue(item) {
  if (!item.properties) return "";
  const p = item.properties;
  if (p.fileName) return p.fileName;
  if (p.path) return p.path;
  if (p.sha256) return `sha256: ${String(p.sha256).slice(0, 16)}...`;
  if (p.certificateSigner) return `signer: ${p.certificateSigner}`;
  return JSON.stringify(p);
}

function wireTabs() {
  document.querySelectorAll(".seg-btn[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn[data-tab]").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeTab = tab.dataset.tab;
      renderActive();
    });
  });
}

function renderBasket() {
  const basket = document.getElementById("selection-basket");
  document.getElementById("basket-count").textContent = String(state.selectedSource.size);
  document.getElementById("basket-noun").textContent = state.selectedSource.size === 1 ? "source item selected" : "source items selected";
  basket.classList.toggle("hidden", state.selectedSource.size === 0);
}

function selectionsByType() {
  const byType = {};
  for (const key of state.selectedSource) {
    const [type, id] = splitKey(key);
    (byType[type] = byType[type] || []).push(id);
  }
  return byType;
}

function wireBasket() {
  document.getElementById("basket-preview").addEventListener("click", async () => {
    if (!state.selectedSource.size) return;
    const selections = selectionsByType();
    try {
      const res = await api.post("/api/migrate/exclusions", { selections, dryRun: true });
      showResults(res.results ?? [], true);
    } catch (err) {
      toast(err.message || "Preview failed", "err");
    }
  });

  document.getElementById("basket-copy").addEventListener("click", async () => {
    if (!state.selectedSource.size) return;
    const selections = selectionsByType();
    if (!confirm(`Copy ${state.selectedSource.size} item(s) to destination?`)) return;
    try {
      const res = await api.post("/api/migrate/exclusions", { selections });
      const ok = res.results?.filter((r) => r.ok).length ?? 0;
      const failed = res.results?.filter((r) => !r.ok).length ?? 0;
      toast(`Copied ${ok} / failed ${failed}`, failed ? "err" : "ok");
      showResults(res.results ?? [], false);
      state.selectedSource.clear();
      renderBasket();
      for (const type of Object.keys(selections)) {
        const tab = TABS.find((t) => t.id === type);
        if (!tab) continue;
        if (tab.section) await refreshSection("dest", tab.section).catch(() => {});
        await loadSide("dest", tab);
      }
      renderActive();
    } catch (err) {
      toast(err.message || "Copy failed", "err");
    }
  });
}

// One line of text that identifies a source item in the results list.
function describe(type, id) {
  const items = state.data[type]?.source;
  const it = Array.isArray(items) ? items.find((x) => idOf(type, x) === id) : null;
  if (!it) return id;
  switch (type) {
    case "isolation":
    case "intrusion-prevention":
      return `${it.direction} ${(it.remoteAddresses || []).join(", ") || "any address"}`;
    case "exploit-mitigation":
      return (it.paths || []).join(", ") || it.name || id;
    case "local-sites":
      return it.url || id;
    case "tls-excluded-websites":
      return it.value || id;
    case "scanning":
      return it.value || id;
    default:
      return formatItemValue(it) || id;
  }
}

function showResults(results, dryRun) {
  const creates = results.filter((r) => r.ok && (r.action === "create" || r.action === "dry-run-create")).length;
  resultsModal({
    title: dryRun ? "Preview: nothing was written" : "Copy results",
    summary: dryRun
      ? `${plural(creates, "item")} would be created on the destination.`
      : `${plural(creates, "item")} created on the destination. Each write is in data/audit.log.`,
    groups: TABS.map((t) => ({
      title: `${t.label.charAt(0).toUpperCase() + t.label.slice(1)}s`,
      rows: results.filter((r) => r.type === t.id).map((r) => ({
        outcome: outcomeOf(r),
        text: describe(t.id, r.sourceId),
        error: r.error,
      })),
    })),
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

boot();
