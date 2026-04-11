import "./nav.js";
import { api } from "./api.js";

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const side = params.get("side") || "source";
  const id = params.get("id");
  if (!id) {
    document.getElementById("content").innerHTML = `<div class="banner banner-err">Missing id parameter.</div>`;
    return;
  }

  document.getElementById("page-title").textContent = `Policy detail (${side})`;
  document.getElementById("page-lead").textContent = `Showing policy ${id} from the ${side} tenant.`;

  try {
    const policy = await api.get(`/api/${side}/policies/${encodeURIComponent(id)}`);
    document.getElementById("content").innerHTML = `
      <h2>${escapeHtml(policy.name)}</h2>
      <dl class="kv-list">
        <dt>ID</dt><dd><code>${escapeHtml(policy.id)}</code></dd>
        <dt>Type</dt><dd><code>${escapeHtml(policy.type)}</code></dd>
        <dt>Enabled</dt><dd>${policy.enabled === false ? "no" : "yes"}</dd>
        <dt>Priority</dt><dd>${escapeHtml(String(policy.priority ?? ""))}</dd>
        <dt>Enforced</dt><dd>${policy.enforced ? "yes" : "no"}</dd>
        <dt>Locked</dt><dd>${policy.lockedByManagingAccount ? "yes" : "no"}</dd>
      </dl>
      <h3 style="margin-top:1.5rem;">Settings</h3>
      <pre>${escapeHtml(JSON.stringify(policy.settings ?? {}, null, 2))}</pre>
    `;
  } catch (err) {
    document.getElementById("content").innerHTML = `<div class="banner banner-err">${escapeHtml(err.message || "Failed to load")}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
