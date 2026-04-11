// Thin fetch wrapper + central redirect logic.
//
// 409 {error:"unconfigured"} means "no credentials on file"; redirect to
// the welcome wizard unless we're already there. Callers should treat
// errors as exceptions.

const WIZARD_PATH = "/welcome.html";

function isWizardPage() {
  return window.location.pathname === WIZARD_PATH;
}

async function request(method, path, body) {
  const init = { method, headers: { "Accept": "application/json" } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (res.status === 409 && data?.error === "unconfigured") {
    if (!isWizardPage()) {
      window.location.href = WIZARD_PATH;
    }
    throw new Error("unconfigured");
  }

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  del: (path) => request("DELETE", path),
};

/**
 * Called on every page load except the wizard itself: checks status and
 * redirects to the wizard if the server is unconfigured. Returns the
 * status payload so callers can render badges.
 */
export async function ensureConfiguredOrRedirect() {
  try {
    const status = await api.get("/api/status");
    if (status.status === "unconfigured" && !isWizardPage()) {
      window.location.href = WIZARD_PATH;
      return null;
    }
    return status;
  } catch (err) {
    // ensureConfigured should not throw - surface once the page renders.
    console.error("status check failed", err);
    return null;
  }
}
