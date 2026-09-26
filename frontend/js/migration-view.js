// Shared pieces for the Migrations list and the job monitor: status names,
// the progress ring, and time formatting. The server works out the status and
// the counts (job.progress); these only draw them.

import { esc, escAttr } from "./ui.js";
import { icon } from "./icons.js";

export const STATUS = {
  requested: { label: "Requested", cls: "tag-accent", live: true },
  "in-progress": { label: "In progress", cls: "tag-warn", live: true },
  completed: { label: "Completed", cls: "tag-ok", icon: "check" },
  "completed-with-failures": { label: "Completed with failures", cls: "tag-bad", icon: "alert" },
  failed: { label: "Failed", cls: "tag-bad", icon: "xCircle" },
  cancelled: { label: "Cancelled", cls: "tag-muted" },
};

export function statusLabel(status) {
  return STATUS[status]?.label ?? String(status || "unknown").replace(/-/g, " ");
}

/** Status tag. `paused` drops the live dot while the job can't be checked. */
export function statusTag(status, { large = false, paused = false } = {}) {
  const s = STATUS[status] ?? { label: statusLabel(status), cls: "tag-muted" };
  const lead = s.live && !paused
    ? `<span class="conn-dot" data-state="${status === "requested" ? "live" : "loading"}"></span>`
    : s.icon ? icon(s.icon) : "";
  return `<span class="tag ${s.cls}${large ? " tag-lg" : ""}">${lead}${esc(s.label)}</span>`;
}

/**
 * Progress ring: arrived (green) and failed (red) as solid arcs, devices
 * handed over and waiting to check in as a faint amber arc, so a job waiting
 * on its first check-in does not look idle. The number is the share arrived.
 */
export function progressRing(p, { size = "lg", stale = false } = {}) {
  const total = p?.total ?? 0;
  const stroke = size === "lg" ? 7 : 11;
  const r = 50 - stroke / 2 - 1;
  const c = 2 * Math.PI * r;
  const share = (n) => (total ? (n / total) * c : 0);
  const arcs = [];
  let at = 0;
  const arc = (len, cls, width = stroke) => {
    if (len <= 0) return;
    // A small gap between arcs, except when one arc is the whole ring.
    const gap = len >= c - 0.01 ? 0 : Math.min(1.2, len / 3);
    arcs.push(`<circle class="ring-arc ${cls}" cx="50" cy="50" r="${r}" stroke-width="${width}" stroke-dasharray="${(len - gap).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}"/>`);
    at += len;
  };
  if (p) {
    arc(share(p.arrived), "is-arrived");
    arc(share(p.failed + p.expired), "is-failed");
    // Handed over but not arrived: a thin line on the track, not a full arc.
    arc(share(p.waiting), "is-waiting", Math.max(2, stroke * 0.36));
  }
  const pct = p ? `${p.percent}<span class="ring-pct">%</span>` : "?";
  const label = !p ? "no detail" : `${p.arrived} of ${total} arrived`;
  const title = !p ? "No device detail for this job" : `${p.arrived} of ${total} arrived, ${p.waiting} waiting for check-in, ${p.requested} not handed over, ${p.failed + p.expired} failed`;
  return `
    <div class="ring ring-${size}${stale ? " is-stale" : ""}${p?.finished && p.percent === 100 ? " is-done" : ""}" role="img" aria-label="${escAttr(title)}" title="${escAttr(title)}">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring-track" cx="50" cy="50" r="${r}" stroke-width="${stroke}"/>
        <g transform="rotate(-90 50 50)">${arcs.join("")}</g>
      </svg>
      <div class="ring-center"><span class="ring-num tnum">${pct}</span>${size === "lg" ? `<span class="ring-cap">${esc(label)}</span>` : ""}</div>
    </div>`;
}

/** "45 s", "12 min", "2 h 5 min", "3 days 4 h". */
export function formatWait(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  const d = Math.floor(h / 24);
  return `${d} days${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** Time only when it is today, date and time otherwise. */
export function formatWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** A job's tenant by role, whether or not the job recorded its tenants. */
export function jobSides(job) {
  const toSource = job.direction === "dest-to-source";
  const side = (key) => {
    const t = job.tenants?.[key];
    return {
      key,
      name: t?.name || (t ? `Tenant ${t.tenantId.slice(0, 8)}` : key === "source" ? "Source tenant" : "Destination tenant"),
      tenantId: t?.tenantId ?? null,
      region: t?.region ?? null,
      recorded: !!t,
      cls: key === "source" ? "" : "is-dest",
    };
  };
  const source = side("source");
  const dest = side("dest");
  return { sending: toSource ? dest : source, receiving: toSource ? source : dest };
}

/**
 * Why a job can't be checked right now, for the list and the monitor, or null
 * when it is being checked normally.
 */
export function accessProblem(job) {
  const m = job.monitor;
  if (!m) return null;
  if (m.state === "rejected") return { tone: "bad", short: "Credentials rejected", icon: "key" };
  if (m.state === "no-credentials") return { tone: "warn", short: "No stored credentials", icon: "key" };
  if (m.state === "not-found") return { tone: "warn", short: "No stored credentials", icon: "key" };
  if (m.state === "error") return { tone: "warn", short: "Last check failed", icon: "alert" };
  return null;
}
