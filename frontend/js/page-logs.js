import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { makeSortable } from "./sortable.js";

const state = {
  entries: [],
  filters: { section: "", side: "", level: "", q: "" },
  autoRefresh: true,
};

let intervalHandle = null;

async function boot() {
  wireFilters();
  await load();
  startAutoRefresh();
}

function wireFilters() {
  document.getElementById("filter-section").addEventListener("change", (e) => {
    state.filters.section = e.target.value;
    render();
  });
  document.getElementById("filter-side").addEventListener("change", (e) => {
    state.filters.side = e.target.value;
    render();
  });
  document.getElementById("filter-level").addEventListener("change", (e) => {
    state.filters.level = e.target.value;
    render();
  });
  document.getElementById("search").addEventListener("input", (e) => {
    state.filters.q = e.target.value;
    render();
  });
  document.getElementById("auto-refresh").addEventListener("change", (e) => {
    state.autoRefresh = e.target.checked;
    if (state.autoRefresh) startAutoRefresh();
    else stopAutoRefresh();
  });
  document.getElementById("refresh-now").addEventListener("click", load);
  document.getElementById("clear-logs").addEventListener("click", async () => {
    if (!confirm("Clear the log buffer?")) return;
    try {
      await api.del("/api/logs");
      toast("Log buffer cleared.", "info");
      await load();
    } catch (err) {
      toast(err.message || "Clear failed", "err");
    }
  });
}

async function load() {
  try {
    const res = await api.get("/api/logs");
    state.entries = res.items || [];
    render();
  } catch (err) {
    document.getElementById("logs-table").innerHTML =
      `<div class="banner banner-err">${escapeHtml(err.message || "Failed to load logs")}</div>`;
  }
}

function startAutoRefresh() {
  if (intervalHandle) return;
  intervalHandle = setInterval(load, 4000);
}
function stopAutoRefresh() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function render() {
  const filtered = state.entries.filter((e) => {
    if (state.filters.section && e.section !== state.filters.section) return false;
    if (state.filters.side && e.side !== state.filters.side) return false;
    if (state.filters.level && e.level !== state.filters.level) return false;
    if (state.filters.q && !e.message.toLowerCase().includes(state.filters.q.toLowerCase())) return false;
    return true;
  });
  // Newest first
  const sorted = [...filtered].reverse();

  if (sorted.length === 0) {
    document.getElementById("logs-table").innerHTML =
      `<div class="empty-state">No log entries match the current filter.</div>`;
    return;
  }

  const rows = sorted
    .map((e) => {
      const ts = new Date(e.ts).toLocaleTimeString();
      const levelClass = `log-level-${e.level}`;
      return `
        <tr class="${levelClass}">
          <td class="log-ts">${escapeHtml(ts)}</td>
          <td><span class="log-level-pill ${levelClass}">${escapeHtml(e.level)}</span></td>
          <td>${escapeHtml(e.section || "")}</td>
          <td>${escapeHtml(e.side || "")}</td>
          <td class="log-message">${escapeHtml(e.message)}</td>
        </tr>`;
    })
    .join("");

  const logsContainer = document.getElementById("logs-table");
  logsContainer.innerHTML = `
    <table class="data-table logs-table">
      <thead>
        <tr><th>Time</th><th>Level</th><th>Section</th><th>Side</th><th>Message</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  makeSortable(logsContainer);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
