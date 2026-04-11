import { api } from "./api.js";

const state = {
  mode: "direct",
  source: { label: "", clientId: "", clientSecret: "", tested: null },
  dest: { label: "", clientId: "", clientSecret: "", tested: null },
  partner: { label: "", clientId: "", clientSecret: "", tested: null, tenants: [] },
  partnerSourceId: "",
  partnerSourceLabel: "",
  partnerDestId: "",
  partnerDestLabel: "",
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- Navigation ---

const STEPS_DIRECT = [
  { key: "1", label: "1. Mode" },
  { key: "2", label: "2. Source creds" },
  { key: "2b", label: "3. Dest creds" },
  { key: "4", label: "4. Save" },
];
const STEPS_PARTNER = [
  { key: "1", label: "1. Mode" },
  { key: "2", label: "2. Credentials" },
  { key: "3", label: "3. Tenants" },
  { key: "4", label: "4. Save" },
];

function rebuildStepPills() {
  const steps = state.mode === "partner" ? STEPS_PARTNER : STEPS_DIRECT;
  const ol = $("#wizard-steps");
  ol.innerHTML = steps.map((s) =>
    `<li data-step="${s.key}">${s.label}</li>`
  ).join("");
}

function showStep(step) {
  $$(".wizard-panel").forEach((p) => p.classList.add("hidden"));
  const panel = $(`.wizard-panel[data-step="${step}"]`);
  if (panel) panel.classList.remove("hidden");

  const steps = state.mode === "partner" ? STEPS_PARTNER : STEPS_DIRECT;
  const currentIdx = steps.findIndex((s) => s.key === String(step));
  $$("#wizard-steps li").forEach((li, idx) => {
    li.classList.remove("active", "done");
    if (idx === currentIdx) li.classList.add("active");
    else if (idx < currentIdx) li.classList.add("done");
  });
}

function updateModeUI() {
  const isDirect = state.mode === "direct";
  $("#direct-creds").classList.toggle("hidden", !isDirect);
  $("#partner-creds").classList.toggle("hidden", isDirect);
  rebuildStepPills();
}

// --- Capturing forms ---

function captureForm(formId, stateKey) {
  const form = $(`#${formId}`);
  state[stateKey].label = form.label?.value.trim() ?? "";
  state[stateKey].clientId = form.clientId.value.trim();
  state[stateKey].clientSecret = form.clientSecret.value.trim();
}

// --- Testing ---

async function testDirect(side) {
  captureForm(`${side}-form`, side);
  const data = state[side];
  const resultEl = $(`#${side}-test-result`);
  if (!data.clientId || !data.clientSecret) {
    resultEl.innerHTML = `<div class="banner banner-warn">Client ID and secret are required.</div>`;
    return;
  }
  resultEl.innerHTML = `<div class="banner banner-info">Testing…</div>`;
  try {
    const res = await api.post("/api/credentials/test", {
      mode: "direct",
      label: side,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
    });
    data.tested = res.identity;
    const labelHint = data.label
      ? ""
      : `<br/><em>Tip: set a friendly label above (e.g. your company name). The API doesn't expose the tenant name for direct credentials.</em>`;
    resultEl.innerHTML = `
      <div class="banner banner-ok">
        Connected to tenant <code>${esc(res.identity.tenantId)}</code>
        · Region: <code>${esc(res.identity.apiHost)}</code>
        ${labelHint}
      </div>`;
    // Enable continue
    if (side === "source") $("#to-step-2b").disabled = false;
    if (side === "dest") $("#direct-to-step-4").disabled = false;
  } catch (err) {
    data.tested = null;
    resultEl.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
  }
}

async function testPartner() {
  captureForm("partner-form", "partner");
  const data = state.partner;
  const resultEl = $("#partner-test-result");
  if (!data.clientId || !data.clientSecret) {
    resultEl.innerHTML = `<div class="banner banner-warn">Client ID and secret are required.</div>`;
    return;
  }
  resultEl.innerHTML = `<div class="banner banner-info">Authenticating and loading tenants…</div>`;
  try {
    const res = await api.post("/api/credentials/test", {
      mode: "partner",
      clientId: data.clientId,
      clientSecret: data.clientSecret,
    });
    data.tested = res;
    data.tenants = res.tenants || [];
    resultEl.innerHTML = `
      <div class="banner banner-ok">
        Authenticated as <strong>${esc(res.idType)}</strong>.
        Found <strong>${data.tenants.length}</strong> managed tenant${data.tenants.length === 1 ? "" : "s"}.
      </div>`;
    populateTenantSelectors(data.tenants);
    $("#partner-to-step-3").disabled = false;
  } catch (err) {
    data.tested = null;
    data.tenants = [];
    resultEl.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
  }
}

function populateTenantSelectors(tenants) {
  const sorted = [...tenants].sort((a, b) => a.name.localeCompare(b.name));
  const options = sorted
    .map((t) => `<option value="${escAttr(t.id)}">${esc(t.name)} (${esc(t.dataRegion)})</option>`)
    .join("");
  const placeholder = `<option value="">— select a tenant —</option>`;
  $("#partner-source-select").innerHTML = placeholder + options;
  $("#partner-dest-select").innerHTML = placeholder + options;
}

// --- Review ---

function renderReview() {
  const container = $("#review-summary");
  if (state.mode === "direct") {
    container.innerHTML = `
      ${reviewCard("Source tenant", state.source, state.source.tested)}
      ${reviewCard("Destination tenant", state.dest, state.dest.tested)}
    `;
  } else {
    const srcTenant = state.partner.tenants.find((t) => t.id === state.partnerSourceId);
    const dstTenant = state.partner.tenants.find((t) => t.id === state.partnerDestId);
    container.innerHTML = `
      <div class="review-card">
        <h3>Partner credentials</h3>
        <dl>
          <dt>Label</dt><dd>${esc(state.partner.label || "(none)")}</dd>
          <dt>Client ID</dt><dd><code>${esc(state.partner.clientId)}</code></dd>
          <dt>Managed tenants</dt><dd>${state.partner.tenants.length}</dd>
        </dl>
      </div>
      <div class="review-card">
        <h3>Source tenant</h3>
        <dl>
          <dt>Name</dt><dd><strong>${esc(srcTenant?.name ?? "?")}</strong></dd>
          <dt>Tenant ID</dt><dd><code>${esc(state.partnerSourceId)}</code></dd>
          <dt>Region</dt><dd>${esc(srcTenant?.dataRegion ?? "")}</dd>
          <dt>Label override</dt><dd>${esc(state.partnerSourceLabel || "(none)")}</dd>
        </dl>
      </div>
      <div class="review-card">
        <h3>Destination tenant</h3>
        <dl>
          <dt>Name</dt><dd><strong>${esc(dstTenant?.name ?? "?")}</strong></dd>
          <dt>Tenant ID</dt><dd><code>${esc(state.partnerDestId)}</code></dd>
          <dt>Region</dt><dd>${esc(dstTenant?.dataRegion ?? "")}</dd>
          <dt>Label override</dt><dd>${esc(state.partnerDestLabel || "(none)")}</dd>
        </dl>
      </div>
    `;
  }
}

function reviewCard(title, creds, identity) {
  return `
    <div class="review-card">
      <h3>${title}</h3>
      <dl>
        <dt>Label</dt><dd>${esc(creds.label || "(none)")}</dd>
        <dt>Client ID</dt><dd><code>${esc(creds.clientId || "(blank)")}</code></dd>
        <dt>Client Secret</dt><dd><code>${creds.clientSecret ? "●●●●●●●●" + esc(creds.clientSecret.slice(-4)) : "(blank)"}</code></dd>
        ${identity ? `<dt>Tenant ID</dt><dd><code>${esc(identity.tenantId)}</code></dd>` : ""}
        ${identity ? `<dt>Region host</dt><dd><code>${esc(identity.apiHost)}</code></dd>` : ""}
      </dl>
    </div>`;
}

// --- Save ---

async function saveConfig() {
  const btn = $("#save-config");
  btn.disabled = true;
  btn.textContent = "Saving…";
  const errorBox = $("#save-error");
  errorBox.classList.add("hidden");

  try {
    let body;
    if (state.mode === "direct") {
      body = {
        mode: "direct",
        source: { label: state.source.label, clientId: state.source.clientId, clientSecret: state.source.clientSecret },
        dest: { label: state.dest.label, clientId: state.dest.clientId, clientSecret: state.dest.clientSecret },
      };
    } else {
      body = {
        mode: "partner",
        clientId: state.partner.clientId,
        clientSecret: state.partner.clientSecret,
        label: state.partner.label,
        sourceTenantId: state.partnerSourceId,
        sourceLabel: state.partnerSourceLabel,
        destTenantId: state.partnerDestId,
        destLabel: state.partnerDestLabel,
      };
    }
    const res = await api.put("/api/credentials", body);
    if (res.status?.status === "configured-ok") {
      window.location.href = "/";
      return;
    }
    const detail = res.status?.source?.error || res.status?.dest?.error || "Configuration saved but contexts failed to initialise.";
    errorBox.textContent = detail;
    errorBox.classList.remove("hidden");
  } catch (err) {
    errorBox.textContent = err.message || "Save failed.";
    errorBox.classList.remove("hidden");
  }
  btn.disabled = false;
  btn.textContent = "Save configuration";
}

// --- Wiring ---

function wire() {
  // Mode picker
  $$('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.mode = e.target.value;
      updateModeUI();
    });
  });
  $("#to-step-2").addEventListener("click", () => {
    updateModeUI();
    showStep(2);
  });

  // Direct: source
  $("#test-source").addEventListener("click", (e) => { e.preventDefault(); testDirect("source"); });
  $("#to-step-2b").addEventListener("click", () => { captureForm("source-form", "source"); showStep("2b"); });

  // Direct: dest
  $("#test-dest").addEventListener("click", (e) => { e.preventDefault(); testDirect("dest"); });
  $("#direct-to-step-4").addEventListener("click", () => {
    captureForm("dest-form", "dest");
    renderReview();
    showStep(4);
  });

  // Partner
  $("#test-partner").addEventListener("click", (e) => { e.preventDefault(); testPartner(); });
  $("#partner-to-step-3").addEventListener("click", () => showStep(3));

  // Partner tenant selection
  const checkPartnerReady = () => {
    state.partnerSourceId = $("#partner-source-select").value;
    state.partnerDestId = $("#partner-dest-select").value;
    state.partnerSourceLabel = $("#partner-source-label").value.trim();
    state.partnerDestLabel = $("#partner-dest-label").value.trim();
    $("#partner-to-step-4").disabled = !state.partnerSourceId || !state.partnerDestId || state.partnerSourceId === state.partnerDestId;
  };
  $("#partner-source-select").addEventListener("change", checkPartnerReady);
  $("#partner-dest-select").addEventListener("change", checkPartnerReady);
  $("#partner-source-label").addEventListener("input", checkPartnerReady);
  $("#partner-dest-label").addEventListener("input", checkPartnerReady);
  $("#partner-to-step-4").addEventListener("click", () => {
    checkPartnerReady();
    renderReview();
    showStep(4);
  });

  // Back buttons
  $$("[data-back]").forEach((btn) => {
    btn.addEventListener("click", () => showStep(btn.dataset.back));
  });
  $("#review-back").addEventListener("click", () => {
    if (state.mode === "partner") showStep(3);
    else showStep("2b");
  });

  // Save
  $("#save-config").addEventListener("click", (e) => { e.preventDefault(); saveConfig(); });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

wire();
showStep(1);
