import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const state = {
  source: [],
  dest: [],
  // Selection is per-side: "source::id" or "dest::id"
  selected: new Set(),
  filters: { source: "", dest: "" },
  hideStale: false,
};

async function boot() {
  await Promise.all([loadSide("source"), loadSide("dest")]);
  wireUI();
}

async function loadSide(side) {
  const target = document.getElementById(`table-${side}`);
  target.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const cached = await getCachedSection(side, "endpoints");
    if (cached.status?.state === "ok") {
      state[side] = cached.items || [];
      renderTable(side);
      return;
    }
    if (cached.status?.state === "loading") {
      target.innerHTML = `<div class="empty-state">Preload in progress…</div>`;
      return;
    }
    if (cached.status?.state === "error") {
      target.innerHTML = `
        <div class="banner banner-err">Preload failed: ${esc(cached.status.error || "")}</div>
        <button class="btn" data-retry="${side}" style="margin-top:0.75rem;">Retry</button>`;
      target.querySelector(`[data-retry="${side}"]`).addEventListener("click", async () => {
        target.innerHTML = `<div class="empty-state">Refreshing…</div>`;
        await refreshSection(side, "endpoints").catch(() => {});
        await loadSide(side);
      });
      return;
    }
    // idle — live fetch
    const res = await api.get(`/api/${side}/endpoints`);
    state[side] = res.items || [];
    renderTable(side);
  } catch (err) {
    target.innerHTML = `<div class="banner banner-err">${esc(err.message || "Failed")}</div>`;
  }
}

function renderTable(side) {
  const filter = state.filters[side].toLowerCase();
  const items = state[side]
    .filter((e) => !filter || (e.hostname || "").toLowerCase().includes(filter))
    .filter((e) => !state.hideStale || !isStale(e))
    .sort((a, b) => (a.hostname || "").localeCompare(b.hostname || ""));

  const target = document.getElementById(`table-${side}`);
  if (items.length === 0) {
    target.innerHTML = `<div class="empty-state">No endpoints${filter ? " match the filter" : ""}.</div>`;
    return;
  }

  const rows = items.map((ep) => {
    const stale = isStale(ep);
    const key = `${side}::${ep.id}`;
    const checked = state.selected.has(key) ? "checked" : "";
    const cb = stale
      ? `<td class="col-check"><input type="checkbox" disabled title="Outside 14-day window"/></td>`
      : `<td class="col-check"><input type="checkbox" data-key="${escAttr(key)}" ${checked}/></td>`;
    const lastSeen = ep.lastSeenAt ? fmtRelative(ep.lastSeenAt) : "—";
    const staleBadge = stale ? `<span class="diff-pill diff-pill-remove" style="margin-left:0.35rem;">stale</span>` : "";
    const os = ep.os ? `${ep.os.name || ep.os.platform || ""}`.trim() : "";
    const ips = (ep.ipv4Addresses || []).slice(0, 2).join(", ") || "—";
    const person = ep.associatedPerson?.name || ep.associatedPerson?.viaLogin || "";
    return `
      <tr>
        ${cb}
        <td>
          <strong>${esc(ep.hostname || "")}</strong>${staleBadge}
          ${person ? `<br/><span class="hint">${esc(person)}</span>` : ""}
        </td>
        <td><span class="hint">${esc(os)}</span></td>
        <td>${esc(ep.health?.overall || "")}</td>
        <td><span class="hint">${esc(ips)}</span></td>
        <td><span class="hint">${lastSeen}</span></td>
        <td class="col-actions"><button class="btn btn-small" data-detail='${escAttr(JSON.stringify(ep))}'>Detail</button></td>
      </tr>`;
  }).join("");

  target.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th class="col-check"></th><th>Hostname</th><th>OS</th><th>Health</th><th>IP</th><th>Seen</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(target);

  target.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      if (e.target.checked) state.selected.add(e.target.dataset.key);
      else state.selected.delete(e.target.dataset.key);
      renderBasket();
    });
  });

  target.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.addEventListener("click", (e) => showDetail(JSON.parse(e.target.dataset.detail)));
  });
}

function wireUI() {
  document.getElementById("search-source").addEventListener("input", (e) => {
    state.filters.source = e.target.value;
    renderTable("source");
  });
  document.getElementById("search-dest").addEventListener("input", (e) => {
    state.filters.dest = e.target.value;
    renderTable("dest");
  });
  document.getElementById("hide-stale").addEventListener("change", (e) => {
    state.hideStale = e.target.checked;
    renderTable("source");
    renderTable("dest");
  });
  document.getElementById("select-all-source").addEventListener("click", () => selectAll("source"));
  document.getElementById("select-all-dest").addEventListener("click", () => selectAll("dest"));
  document.getElementById("basket-clear").addEventListener("click", () => {
    state.selected.clear();
    renderTable("source");
    renderTable("dest");
    renderBasket();
  });
  document.getElementById("basket-migrate").addEventListener("click", startMigrate);
}

function selectAll(side) {
  const filter = state.filters[side].toLowerCase();
  const eligible = state[side].filter(
    (e) => !isStale(e) && (!filter || (e.hostname || "").toLowerCase().includes(filter)),
  );
  for (const e of eligible) state.selected.add(`${side}::${e.id}`);
  renderTable(side);
  renderBasket();
  toast(`Selected ${eligible.length} eligible endpoint${eligible.length === 1 ? "" : "s"}.`, "ok");
}

function renderBasket() {
  const basket = document.getElementById("selection-basket");
  const srcCount = [...state.selected].filter((k) => k.startsWith("source::")).length;
  const dstCount = [...state.selected].filter((k) => k.startsWith("dest::")).length;
  const total = srcCount + dstCount;
  basket.classList.toggle("hidden", total === 0);

  let text = "";
  if (srcCount > 0 && dstCount > 0) {
    text = `${srcCount} source + ${dstCount} dest endpoints selected (pick one direction)`;
  } else if (srcCount > 0) {
    text = `${srcCount} source endpoint${srcCount === 1 ? "" : "s"} → migrate to destination`;
  } else {
    text = `${dstCount} dest endpoint${dstCount === 1 ? "" : "s"} → migrate back to source`;
  }
  document.getElementById("basket-text").textContent = text;
}

function startMigrate() {
  const srcIds = [...state.selected].filter((k) => k.startsWith("source::")).map((k) => k.slice(8));
  const dstIds = [...state.selected].filter((k) => k.startsWith("dest::")).map((k) => k.slice(6));

  if (srcIds.length > 0 && dstIds.length > 0) {
    toast("Select endpoints from one side only per migration.", "info");
    return;
  }
  if (srcIds.length === 0 && dstIds.length === 0) return;

  const direction = srcIds.length > 0 ? "source-to-dest" : "dest-to-source";
  const ids = srcIds.length > 0 ? srcIds : dstIds;

  // Store in sessionStorage for the migrate page
  sessionStorage.setItem("endpointSelection", JSON.stringify(ids));
  sessionStorage.setItem("migrationDirection", direction);
  window.location.href = "/migrate.html";
}

function showDetail(ep) {
  let existing = document.getElementById("detail-modal");
  if (existing) existing.remove();

  const products = (ep.assignedProducts || []).map((p) =>
    `<li><code>${esc(p.code)}</code> v${esc(p.version)} — ${esc(p.status)}</li>`
  ).join("") || "<li>—</li>";

  const services = (ep.health?.services?.serviceDetails || []).map((s) =>
    `<li>${esc(s.name)}: ${esc(s.status)}</li>`
  ).join("") || "<li>—</li>";

  const modal = document.createElement("div");
  modal.id = "detail-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-card">
      <header class="modal-header">
        <h2>${esc(ep.hostname)}</h2>
        <button class="btn btn-small modal-close">Close</button>
      </header>
      <div class="modal-body">
        <dl class="kv-list">
          <dt>Endpoint ID</dt><dd><code>${esc(ep.id)}</code></dd>
          <dt>Type</dt><dd>${esc(ep.type || "")}</dd>
          <dt>OS</dt><dd>${esc(ep.os?.name || "")} ${esc(String(ep.os?.majorVersion ?? ""))}.${esc(String(ep.os?.minorVersion ?? ""))} (${esc(ep.os?.platform || "")})</dd>
          <dt>Is server</dt><dd>${ep.os?.isServer ? "yes" : "no"}</dd>
          <dt>Health</dt><dd>${esc(ep.health?.overall || "")}</dd>
          <dt>Threats</dt><dd>${esc(ep.health?.threats?.status || "")}</dd>
          <dt>Services</dt><dd>${esc(ep.health?.services?.status || "")}</dd>
          <dt>IPv4</dt><dd>${esc((ep.ipv4Addresses || []).join(", ") || "—")}</dd>
          <dt>IPv6</dt><dd>${esc((ep.ipv6Addresses || []).join(", ") || "—")}</dd>
          <dt>MAC</dt><dd>${esc((ep.macAddresses || []).join(", ") || "—")}</dd>
          <dt>User</dt><dd>${esc(ep.associatedPerson?.name || "")} ${esc(ep.associatedPerson?.viaLogin ? `(${ep.associatedPerson.viaLogin})` : "")}</dd>
          <dt>Tamper protection</dt><dd>${ep.tamperProtectionEnabled ? "enabled" : "disabled"}</dd>
          <dt>Isolation</dt><dd>${esc(ep.isolation?.status || "—")}</dd>
          <dt>Lockdown</dt><dd>${esc(ep.lockdown?.status || "—")}</dd>
          <dt>Group</dt><dd>${esc(ep.groupName || "—")} ${ep.groupId ? `<code>${esc(ep.groupId)}</code>` : ""}</dd>
          <dt>Last seen</dt><dd>${ep.lastSeenAt ? new Date(ep.lastSeenAt).toLocaleString() : "—"}</dd>
        </dl>
        <h3 style="margin-top:1rem;">Assigned products</h3>
        <ul>${products}</ul>
        <h3 style="margin-top:1rem;">Service details</h3>
        <ul>${services}</ul>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector(".modal-close").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

function isStale(ep) {
  if (!ep.lastSeenAt) return true;
  return Date.now() - new Date(ep.lastSeenAt).getTime() > FOURTEEN_DAYS_MS;
}

function fmtRelative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

boot();
