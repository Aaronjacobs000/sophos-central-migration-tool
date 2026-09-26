import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";
import { rowMenu, wireRowMenus, onDestCell, ON_DEST_HEADER, plural, resultsModal, outcomeOf, countOutcomes, notesOf } from "./ui.js";

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
  document.querySelectorAll(".seg-btn[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn[data-tab]").forEach((t) => t.classList.remove("active"));
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
  for (const tab of ["endpoint", "user"]) {
    const el = document.querySelector(`[data-count="${tab}"]`);
    if (el) el.textContent = String((state[tab].source || []).length);
  }
}

function renderTable(side) {
  const tab = state.activeTab;
  const items = state[tab][side] || [];
  const filter = state.filters[side].toLowerCase();
  const filtered = items.filter((g) => !filter || g.name.toLowerCase().includes(filter));
  const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
  const target = document.getElementById(`table-${side}`);

  const otherNames = new Set(
    (state[tab][side === "source" ? "dest" : "source"] || []).map((g) => g.name.toLowerCase()),
  );

  if (sorted.length === 0) {
    const type = tab === "endpoint" ? "endpoint" : "user";
    target.innerHTML = `<div class="empty-state">No ${type} groups${filter ? " match the filter" : ""}.</div>`;
    return;
  }

  const rows = sorted.map((g) => {
    const key = `${tab}::${g.id}`;
    const checked = side === "source" && state.selectedSource.has(key) ? "checked" : "";
    const onBoth = otherNames.has(g.name.toLowerCase());
    const checkbox = side === "source"
      ? `<td class="col-check"><input type="checkbox" data-key="${escAttr(key)}" ${checked} aria-label="Select ${escAttr(g.name)}"/></td>${onDestCell(onBoth)}`
      : "";
    const badge = side === "source" && !onBoth ? `<span class="tag tag-src">not on destination</span>` : "";
    const extra = tab === "user"
      ? `<td><span class="hint">${esc(g.source?.type ?? g.source ?? "")}</span></td><td class="tnum">${g.usersCount ?? g.users?.total ?? "-"}</td>`
      : `<td><span class="tag tag-muted">${esc(g.type || g.endpointType || "")}</span></td>`;
    const deleteBtn = side === "dest"
      ? `<td class="col-actions">${rowMenu([{ label: "Delete from destination", icon: "trash", danger: true, attrs: `data-delete="${escAttr(g.id)}" data-name="${escAttr(g.name)}"` }])}</td>`
      : "";
    const cls = [onBoth ? "is-dim" : "", checked ? "selected" : ""].filter(Boolean).join(" ");
    return `<tr${cls ? ` class="${cls}"` : ""}${onBoth ? ' title="Exists on both sides"' : ""}>${checkbox}<td><span class="cell-name">${esc(g.name)}</span> ${badge}</td>${extra}${deleteBtn}</tr>`;
  }).join("");

  const headerExtra = tab === "user"
    ? `<th>Source</th><th>Users</th>`
    : `<th>Type</th>`;
  const deleteHeader = side === "dest" ? `<th class="col-actions"></th>` : "";
  const checkHeader = side === "source" ? `<th class="col-check"></th>${ON_DEST_HEADER}` : "";

  target.innerHTML = `
    <table class="data-table">
      <thead><tr>${checkHeader}<th>Name</th>${headerExtra}${deleteHeader}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(target);
  wireRowMenus(target);

  if (side === "source") {
    target.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        if (e.target.checked) state.selectedSource.add(e.target.dataset.key);
        else state.selectedSource.delete(e.target.dataset.key);
        e.target.closest("tr")?.classList.toggle("selected", e.target.checked);
        renderBasket();
      });
    });
  }
  if (side === "dest") {
    target.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.currentTarget.dataset.delete;
        const name = e.currentTarget.dataset.name;
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
  document.getElementById("basket-noun").textContent = count === 1 ? "source group selected" : "source groups selected";
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

    // Each request's results, or a failed row per group when the request itself fails.
    const mirror = async (path, body, ids, tab) => {
      try {
        return (await api.post(path, body)).results ?? [];
      } catch (err) {
        return ids.map((id) => ({ sourceId: id, sourceName: nameOf(tab, id), ok: false, action: "create", error: err.message || "Mirror failed" }));
      }
    };
    const endpoint = epIds.length ? await mirror("/api/migrate/groups", { groupIds: epIds }, epIds, "endpoint") : [];
    const user = ugIds.length ? await mirror("/api/migrate/user-groups", { userGroupIds: ugIds }, ugIds, "user") : [];
    const n = countOutcomes([...endpoint, ...user]);
    toast(`Mirrored ${n.created} / failed ${n.failed}`, n.failed ? "err" : "ok");
    showResults(endpoint, user);
    // Keep the selection when nothing got through, so it can be tried again.
    if (n.failed < total) state.selectedSource.clear();
    await refreshSection("dest", "groups").catch(() => {});
    await Promise.all([loadEndpointGroups("dest"), loadUserGroups("dest")]);
    renderActive();
  });
}

function nameOf(tab, id) {
  return (state[tab].source || []).find((g) => g.id === id)?.name ?? id;
}

/** The results list: each group tagged created, already there or failed. */
function showResults(endpoint, user) {
  const n = countOutcomes([...endpoint, ...user]);
  const row = (tab) => (r) => ({ outcome: outcomeOf(r), text: nameOf(tab, r.sourceId), error: r.error, notes: notesOf(r) });
  resultsModal({
    title: "Mirror results",
    summary: `${plural(n.created, "group")} created on the destination. Each write is in data/audit.log.`,
    groups: [
      { title: "Endpoint groups", rows: endpoint.map(row("endpoint")) },
      { title: "User groups", rows: user.map(row("user")) },
    ],
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

boot();
