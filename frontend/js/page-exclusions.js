import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";
import { rowMenu, wireRowMenus } from "./ui.js";

const TABS = [
  { id: "scanning", section: "scanning-exclusions" },
  { id: "allowed-items", section: "allowed-items" },
  { id: "blocked-items", section: "blocked-items" },
];
const state = {
  activeTab: "scanning",
  data: {
    "scanning": { source: [], dest: [] },
    "allowed-items": { source: [], dest: [] },
    "blocked-items": { source: [], dest: [] },
  },
  selectedSource: new Set(), // keyed by `${type}::${id}`
};

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
    for (const it of data) state.selectedSource.add(`${type}::${it.id}`);
    renderActive();
    renderBasket();
    toast(`Selected ${data.length} ${type} item${data.length === 1 ? "" : "s"}.`, "ok");
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
    target.innerHTML = `<div class="empty-state">Preload still in progress…</div>`;
    return;
  }
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    target.innerHTML = `<div class="empty-state">No items.</div>`;
    return;
  }
  const other = state.data[type][side === "source" ? "dest" : "source"];
  const otherKeys = new Set(Array.isArray(other) ? other.map(itemKey) : []);
  const rows = items
    .map((it) => {
      const checked = side === "source" && state.selectedSource.has(`${type}::${it.id}`) ? "checked" : "";
      const checkbox = side === "source"
        ? `<td class="col-check"><input type="checkbox" data-id="${escapeAttr(it.id)}" ${checked} aria-label="Select item"/></td>`
        : "";
      const display = type === "scanning"
        ? `${escapeHtml(it.value || "")}`
        : `${escapeHtml(formatItemValue(it))}`;
      const actionCell = side === "dest"
        ? `<td class="col-actions">${rowMenu([{ label: "Delete from destination", icon: "trash", danger: true, attrs: `data-delete-dest="${escapeAttr(it.id)}" data-display="${escapeAttr(typeof it.value === "string" ? it.value : formatItemValue(it))}"` }])}</td>`
        : "";
      const onBoth = otherKeys.has(itemKey(it));
      const cls = [onBoth ? "is-dim" : "", checked ? "selected" : ""].filter(Boolean).join(" ");
      return `
        <tr${cls ? ` class="${cls}"` : ""}${onBoth ? ' title="Exists on both sides"' : ""}>
          ${checkbox}
          <td><span class="tag tag-muted">${escapeHtml(it.type || "")}</span></td>
          <td class="mono-cell">${display}</td>
          <td><span class="hint">${escapeHtml(it.comment || "")}</span></td>
          ${actionCell}
        </tr>`;
    })
    .join("");
  const headerExtra = side === "dest" ? `<th class="col-actions"></th>` : "";
  const checkHeader = side === "source" ? `<th class="col-check"></th>` : "";
  target.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>${checkHeader}<th>Kind</th><th>Value</th><th>Comment</th>${headerExtra}</tr>
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

function wireBasket() {
  document.getElementById("basket-copy").addEventListener("click", async () => {
    if (!state.selectedSource.size) return;
    const byType = {};
    for (const key of state.selectedSource) {
      const [type, id] = key.split("::");
      const apiKey = type === "scanning" ? "scanning" : type;
      (byType[apiKey] = byType[apiKey] || []).push(id);
    }
    if (!confirm(`Copy ${state.selectedSource.size} item(s) to destination?`)) return;
    try {
      const res = await api.post("/api/migrate/exclusions", { selections: byType });
      const ok = res.results?.filter((r) => r.ok).length ?? 0;
      const failed = res.results?.filter((r) => !r.ok).length ?? 0;
      toast(`Copied ${ok} / failed ${failed}`, failed ? "err" : "ok");
      state.selectedSource.clear();
      renderBasket();
      const tab = TABS.find((t) => t.id === state.activeTab);
      if (tab) {
        await refreshSection("dest", tab.section).catch(() => {});
        await loadSide("dest", tab);
      }
      renderActive();
    } catch (err) {
      toast(err.message || "Copy failed", "err");
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
