import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";

let currentMode = "direct";

async function boot() {
  let creds;
  try {
    creds = await api.get("/api/credentials");
  } catch (err) {
    // Credentials endpoint should always work; if it doesn't, show error
    document.getElementById("direct-panels").innerHTML =
      `<div class="banner banner-err">Failed to load credentials: ${esc(err.message || "unknown error")}</div>`;
    return;
  }
  currentMode = creds.mode || "direct";

  // Set the mode radio
  const radio = document.querySelector(`input[name="cred-mode"][value="${currentMode}"]`);
  if (radio) radio.checked = true;
  showModePanel(currentMode);

  // Populate direct panels
  populateDirect("source", creds.direct.source);
  populateDirect("dest", creds.direct.dest);

  // Populate partner panel
  populatePartner(creds.partner);

  wireModeToggle();
  wireDirectForms();
  wirePartnerForm();
}

function showModePanel(mode) {
  document.getElementById("direct-panels").classList.toggle("hidden", mode !== "direct");
  document.getElementById("partner-panel").classList.toggle("hidden", mode !== "partner");
}

function wireModeToggle() {
  document.querySelectorAll('input[name="cred-mode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      currentMode = e.target.value;
      showModePanel(currentMode);
    });
  });
}

// --- Direct mode ---

function populateDirect(side, masked) {
  const form = document.querySelector(`.cred-form[data-side="${side}"]`);
  form.label.value = masked.label || "";
  form.clientId.value = masked.clientId || "";
  form.clientSecret.value = masked.clientSecretMasked || "";
  const hint = form.querySelector('[data-field="clientSecret-hint"]');
  hint.textContent = masked.configured ? "Leave unchanged to keep current secret." : "No secret stored yet.";
  form.dataset.originalSecretMasked = masked.clientSecretMasked || "";
}

function wireDirectForms() {
  document.querySelectorAll("#direct-panels .cred-form").forEach((form) => {
    const side = form.dataset.side;
    const banner = form.querySelector('[data-field="banner"]');

    form.querySelector(".reveal-btn").addEventListener("click", () => {
      const input = form.clientSecret;
      const btn = form.querySelector(".reveal-btn");
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "Reveal" : "Hide";
    });

    form.querySelector(".test-btn").addEventListener("click", async () => {
      const payload = extractDirectPayload(form);
      if (!payload.clientId) { setBanner(banner, "warn", "Client ID required."); return; }
      if (!payload.clientSecret) {
        setBanner(banner, "warn", "Enter or change the Client Secret to test the connection. The stored secret cannot be used for testing because it is never sent back to the browser.");
        return;
      }
      setBanner(banner, "info", "Testing…");
      try {
        const res = await api.post("/api/credentials/test", {
          mode: "direct",
          label: side,
          clientId: payload.clientId,
          clientSecret: payload.clientSecret,
        });
        setBanner(banner, "ok", `Connected to tenant ${res.identity.tenantId}. Region: ${res.identity.apiHost}`);
      } catch (err) {
        setBanner(banner, "err", err.message || "Test failed");
      }
    });

    form.querySelector(".save-btn").addEventListener("click", async () => {
      const payload = extractDirectPayload(form);
      setBanner(banner, "info", "Saving…");
      try {
        const body = { mode: "direct", [side]: payload };
        const res = await api.put("/api/credentials", body);
        if (res.status?.status === "configured-ok") {
          toast(`${side} saved and reconnected.`, "ok");
          setBanner(banner, "ok", `Saved. Tenant ${res.status[side]?.identity?.tenantId ?? "ok"}.`);
        } else {
          setBanner(banner, "err", `Saved, but reconnect failed: ${res.status[side]?.error ?? "unknown"}`);
        }
        const updated = await api.get("/api/credentials");
        populateDirect(side, updated.direct[side]);
      } catch (err) {
        setBanner(banner, "err", err.message || "Save failed");
      }
    });
  });
}

function extractDirectPayload(form) {
  const label = form.label.value.trim();
  const clientId = form.clientId.value.trim();
  const clientSecret = form.clientSecret.value.trim();
  const payload = { clientId, label };
  if (clientSecret !== form.dataset.originalSecretMasked) payload.clientSecret = clientSecret;
  return payload;
}

// --- Partner mode ---

function populatePartner(masked) {
  const form = document.getElementById("partner-cred-form");
  form.label.value = masked.label || "";
  form.clientId.value = masked.clientId || "";
  form.clientSecret.value = masked.clientSecretMasked || "";
  const hint = form.querySelector('[data-field="clientSecret-hint"]');
  hint.textContent = masked.configured ? "Leave unchanged to keep current secret." : "";
  form.dataset.originalSecretMasked = masked.clientSecretMasked || "";
  document.getElementById("p-source-label").value = masked.sourceLabel || "";
  document.getElementById("p-dest-label").value = masked.destLabel || "";

  // If we have tenant selections stored, we'll need to load the tenant list first
  if (masked.configured && masked.sourceTenantId) {
    // Auto-load tenants on boot if we're in partner mode
    if (currentMode === "partner") {
      loadPartnerTenants(masked.sourceTenantId, masked.destTenantId);
    }
  }
}

function wirePartnerForm() {
  const form = document.getElementById("partner-cred-form");

  form.querySelector(".reveal-btn").addEventListener("click", () => {
    const input = form.clientSecret;
    const btn = form.querySelector(".reveal-btn");
    input.type = input.type === "password" ? "text" : "password";
    btn.textContent = input.type === "password" ? "Reveal" : "Hide";
  });

  document.getElementById("test-partner-btn").addEventListener("click", () => {
    loadPartnerTenants();
  });

  document.getElementById("save-partner-btn").addEventListener("click", savePartner);
}

async function loadPartnerTenants(presetSource, presetDest) {
  const form = document.getElementById("partner-cred-form");
  const banner = form.querySelector('[data-field="banner"]');
  const clientId = form.clientId.value.trim();
  const clientSecret = form.clientSecret.value.trim();
  const secretChanged = clientSecret !== form.dataset.originalSecretMasked;

  if (!clientId) { setBanner(banner, "warn", "Client ID required."); return; }
  if (!secretChanged) {
    // Secret hasn't been changed — try to load tenants from the existing
    // partner context (already authenticated server-side) instead of
    // calling the test endpoint which requires the raw secret.
    setBanner(banner, "info", "Loading tenants from existing session…");
    try {
      const res = await api.get("/api/partner/tenants");
      if (res.items && res.items.length > 0) {
        setBanner(banner, "ok", `${res.items.length} tenant${res.items.length === 1 ? "" : "s"} loaded from existing session.`);
        const sorted = (res.items || []).sort((a, b) => a.name.localeCompare(b.name));
        const options = sorted.map((t) => `<option value="${escAttr(t.id)}">${esc(t.name)} (${esc(t.dataRegion)})</option>`).join("");
        document.getElementById("p-source-select").innerHTML = `<option value="">— select —</option>` + options;
        document.getElementById("p-dest-select").innerHTML = `<option value="">— select —</option>` + options;
        if (presetSource) document.getElementById("p-source-select").value = presetSource;
        if (presetDest) document.getElementById("p-dest-select").value = presetDest;
        return;
      }
    } catch {}
    setBanner(banner, "warn", "Enter or change the Client Secret to re-authenticate. The stored secret is not sent to the browser.");
    return;
  }

  setBanner(banner, "info", "Authenticating and loading tenants…");

  try {
    const res = await api.post("/api/credentials/test", {
      mode: "partner",
      clientId,
      clientSecret,
    });

    setBanner(banner, "ok", `${res.idType} — ${res.tenantCount} tenant${res.tenantCount === 1 ? "" : "s"} loaded.`);
    const sorted = (res.tenants || []).sort((a, b) => a.name.localeCompare(b.name));
    const options = sorted.map((t) => `<option value="${escAttr(t.id)}">${esc(t.name)} (${esc(t.dataRegion)})</option>`).join("");
    const placeholder = `<option value="">— select —</option>`;
    document.getElementById("p-source-select").innerHTML = placeholder + options;
    document.getElementById("p-dest-select").innerHTML = placeholder + options;

    if (presetSource) document.getElementById("p-source-select").value = presetSource;
    if (presetDest) document.getElementById("p-dest-select").value = presetDest;
  } catch (err) {
    setBanner(banner, "err", err.message || "Failed to load tenants");
  }
}

async function savePartner() {
  const form = document.getElementById("partner-cred-form");
  const banner = document.getElementById("partner-save-banner");
  const clientId = form.clientId.value.trim();
  const clientSecret = form.clientSecret.value.trim();
  const secretChanged = clientSecret !== form.dataset.originalSecretMasked;

  const body = {
    mode: "partner",
    clientId,
    label: form.label.value.trim(),
    sourceTenantId: document.getElementById("p-source-select").value,
    sourceLabel: document.getElementById("p-source-label").value.trim(),
    destTenantId: document.getElementById("p-dest-select").value,
    destLabel: document.getElementById("p-dest-label").value.trim(),
  };
  if (secretChanged) body.clientSecret = clientSecret;

  setBanner(banner, "info", "Saving…");
  try {
    const res = await api.put("/api/credentials", body);
    if (res.status?.status === "configured-ok") {
      toast("Partner credentials saved and tenants connected.", "ok");
      setBanner(banner, "ok", "Saved. Both tenants connected.");
    } else {
      const err = res.status?.source?.error || res.status?.dest?.error || res.status?.lastError?.partner || "Unknown";
      setBanner(banner, "err", `Saved, but: ${err}`);
    }
  } catch (err) {
    setBanner(banner, "err", err.message || "Save failed");
  }
}

// --- Shared ---

function setBanner(el, variant, text) {
  el.className = `banner banner-${variant}`;
  el.textContent = text;
  el.classList.remove("hidden");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

boot();
