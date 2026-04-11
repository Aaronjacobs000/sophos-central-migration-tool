import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";

const state = {
  activeTab: "endpoint", // "endpoint" | "user"
  endpoint: { source: [], dest: [] },
  user: { source: [], dest: [] },
  selectedSource: new Set(), // keyed by `${tab}::${id}`
  filters: { source: "", dest: "" },
};

async function boot() {
  wireTabs();
  wireFilters();
  wireBasket();
  wireSelectAll();
  await Promise.all([
    loadEndpointGroups("source"),
    loadEndpointGroups("dest"),
    loadUserGroups("source"),
    loadUserGroups("dest"),
  ]);
  renderActive();
}

// --- Data loading ---

async function loadEndpointGroups(side) {
  try {
    const cached = await getCachedSection(side, "groups");
    if (cached.status?.state === "ok") {
      state.endpoint[side] = cached.items || [];
      return;
    }
    if (cached.status?.state === "loading") { state.endpoint[side] = []; return; }
    if (cached.status?.state === "error") { state.endpoint[side] = []; return; }
    const res = await api.get(`/api/${side}/groups`);
    state.endpoint[side] = res.items || [];
  } catch { state.endpoint[side] = []; }
}

async function loadUserGroups(side) {
  try {
    const res = await api.get(`/api/${side}/user-groups`);
    state.user[side] = res.items || [];
  } catch { state.user[side] = []; }
}

// --- Tabs ---

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeTab = tab.dataset.tab;
      renderActive();
    });
  });
}

// --- Rendering ---

function renderActive() {
  renderTable("source");
  renderTable("dest");
  renderBasket();
}

function renderTable(side) {
  const tab = state.activeTab;
  const items = state[tab][side] || [];
  const filter = state.filters[side].toLowerCase();
  const filtered = items.filter((g) => !filter || g.name.toLowerCase().includes(filter));
  const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
  const target = document.getElementById(`table-${side}`);

  const destNames = side === "source"
    ? new Set((state[tab].dest || []).map((g) => g.name.toLowerCase()))
    : null;

  if (sorted.length === 0) {
    const type = tab === "endpoint" ? "endpoint" : "user";
    target.innerHTML = `<div class="empty-state">No ${type} groups${filter ? " match the filter" : ""}.</div>`;
    return;
  }

  const rows = sorted.map((g) => {
    const key = `${tab}::${g.id}`;
    const checked = side === "source" && state.selectedSource.has(key) ? "checked" : "";
    const checkbox = side === "source"
      ? `<td class="col-check"><input type="checkbox" data-key="${escAttr(key)}" ${checked}/></td>`
      : `<td class="col-check"></td>`;
    const onlyOnSource = side === "source" && destNames && !destNames.has(g.name.toLowerCase());
    const badge = onlyOnSource ? `<span class="diff-pill diff-pill-add">not on dest</span>` : "";
    const extra = tab === "user"
      ? `<td><span class="hint">${g.source || ""}</span></td><td>${g.usersCount ?? "—"}</td>`
      : `<td><code>${esc(g.type || g.endpointType || "")}</code></td>`;
    const deleteBtn = side === "dest"
      ? `<td class="col-actions"><button class="btn btn-small btn-danger" data-delete="${escAttr(g.id)}" data-name="${escAttr(g.name)}">Delete</button></td>`
      : "";
    return `<tr>${checkbox}<td>${esc(g.name)} ${badge}</td>${extra}${deleteBtn}</tr>`;
  }).join("");

  const headerExtra = tab === "user"
    ? `<th>Source</th><th>Users</th>`
    : `<th>Type</th>`;
  const deleteHeader = side === "dest" ? "<th></th>" : "";

  target.innerHTML = `
    <table class="data-table">
      <thead><tr><th class="col-check"></th><th>Name</th>${headerExtra}${deleteHeader}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(target);

  if (side === "source") {
    target.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        if (e.target.checked) state.selectedSource.add(e.target.dataset.key);
        else state.selectedSource.delete(e.target.dataset.key);
        renderBasket();
      });
    });
  }
  if (side === "dest") {
    target.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.dataset.delete;
        const name = e.target.dataset.name;
        if (!confirm(`Delete "${name}" from destination?\n\nThis action is irreversible.`)) return;
        if (!confirm(`Are you absolutely sure? "${name}" will be permanently removed.`)) return;
        const path = tab === "user" ? "user-groups" : "groups";
        try {
          await api.del(`/api/dest/${path}/${encodeURIComponent(id)}`);
          toast(`Deleted "${name}".`, "ok");
          if (tab === "endpoint") { await refreshSection("dest", "groups").catch(() => {}); await loadEndpointGroups("dest"); }
          else { await loadUserGroups("dest"); }
          renderActive();
        } catch (err) { toast(err.message || "Delete failed", "err"); }
      });
    });
  }
}

// --- Selection ---

function wireSelectAll() {
  document.getElementById("select-all-source").addEventListener("click", () => {
    const tab = state.activeTab;
    const items = state[tab].source || [];
    for (const g of items) state.selectedSource.add(`${tab}::${g.id}`);
    renderActive();
    toast(`Selected ${items.length} group${items.length === 1 ? "" : "s"}.`, "ok");
  });
  document.getElementById("clear-source").addEventListener("click", () => {
    const tab = state.activeTab;
    for (const key of [...state.selectedSource]) {
      if (key.startsWith(`${tab}::`)) state.selectedSource.delete(key);
    }
    renderActive();
  });
}

function renderBasket() {
  const count = state.selectedSource.size;
  const basket = document.getElementById("selection-basket");
  document.getElementById("basket-count").textContent = String(count);
  basket.classList.toggle("hidden", count === 0);
}

function wireFilters() {
  document.getElementById("search-source").addEventListener("input", (e) => {
    state.filters.source = e.target.value;
    renderActive();
  });
  document.getElementById("search-dest").addEventListener("input", (e) => {
    state.filters.dest = e.target.value;
    renderActive();
  });
}

function wireBasket() {
  document.getElementById("basket-mirror").addEventListener("click", async () => {
    // Separate endpoint and user group IDs
    const epIds = [];
    const ugIds = [];
    for (const key of state.selectedSource) {
      const [tab, id] = key.split("::");
      if (tab === "endpoint") epIds.push(id);
      else ugIds.push(id);
    }

    if (epIds.length === 0 && ugIds.length === 0) return;
    const total = epIds.length + ugIds.length;
    if (!confirm(`Mirror ${total} group${total === 1 ? "" : "s"} to destination?\n\nNote: only name and metadata are copied. Membership is not transferred.`)) return;

    const results = [];
    try {
      if (epIds.length > 0) {
        const res = await api.post("/api/migrate/groups", { groupIds: epIds });
        results.push(...(res.results || []));
      }
      // Mirror user groups manually (no dedicated migrate route; create each on dest)
      for (const id of ugIds) {
        const ug = state.user.source.find((g) => g.id === id);
        if (!ug) continue;
        try {
          await api.post("/api/dest/user-groups", { name: ug.name, description: ug.description });
          results.push({ ok: true, sourceName: ug.name, action: "create" });
        } catch (err) {
          results.push({ ok: false, sourceName: ug.name, error: err.message });
        }
      }
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      toast(`Mirrored ${ok} / failed ${failed}`, failed ? "err" : "ok");
      state.selectedSource.clear();
      await refreshSection("dest", "groups").catch(() => {});
      await Promise.all([loadEndpointGroups("dest"), loadUserGroups("dest")]);
      renderActive();
    } catch (err) {
      toast(err.message || "Mirror failed", "err");
    }
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

boot();
