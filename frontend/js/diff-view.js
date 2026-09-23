/**
 * Side-by-side compare renderer for policy settings.
 *
 * The backend already returns the full source and dest objects plus a flat
 * change list. This module ignores the change list and walks the union of
 * leaf paths, producing rows that the UI groups by section.
 */

const STATUS_LABEL = {
  match: "match",
  differ: "differs",
  "source-only": "source only",
  "dest-only": "destination only",
};

const STATUS_PILL_CLASS = {
  match: "tag-ok",
  differ: "tag-warn",
  "source-only": "tag-src",
  "dest-only": "tag-dst",
};

/**
 * Walk both trees and produce a flat list of leaf entries.
 *
 * Each entry: { path: string[], source: any, dest: any, status }
 *
 * Objects recurse. Arrays and primitives are leaves so we don't get an
 * explosion of internal "[0].x.y" rows.
 */
export function flattenForCompare(source, dest) {
  const out = [];
  walk(source, dest, [], out);
  // Sort by joined path for stable output
  out.sort((a, b) => a.path.join(".").localeCompare(b.path.join(".")));
  return out;
}

function walk(s, d, path, out) {
  const sIsObj = isPlainObject(s);
  const dIsObj = isPlainObject(d);

  if (sIsObj || dIsObj) {
    const keys = new Set();
    if (sIsObj) for (const k of Object.keys(s)) keys.add(k);
    if (dIsObj) for (const k of Object.keys(d)) keys.add(k);
    for (const k of keys) {
      const sv = sIsObj ? s[k] : undefined;
      const dv = dIsObj ? d[k] : undefined;
      walk(sv, dv, [...path, k], out);
    }
    return;
  }

  out.push({
    path,
    source: s,
    dest: d,
    status: leafStatus(s, d),
  });
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function leafStatus(s, d) {
  const sUndef = s === undefined;
  const dUndef = d === undefined;
  if (sUndef && dUndef) return "match";
  if (sUndef) return "dest-only";
  if (dUndef) return "source-only";
  return deepEqual(s, d) ? "match" : "differ";
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/**
 * Group leaf entries by their top-level key. Items with empty paths land
 * under `(root)`.
 */
export function groupByTopKey(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = e.path[0] ?? "(root)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return groups;
}

/**
 * Compute summary counts across a list of entries.
 */
export function summarizeEntries(entries) {
  const counts = { total: entries.length, match: 0, differ: 0, "source-only": 0, "dest-only": 0 };
  for (const e of entries) counts[e.status]++;
  return counts;
}

/**
 * Render the summary tags shown above the comparison table.
 */
export function renderCompareSummary(summary) {
  const part = (n, cls, text) => (n ? `<span class="tag ${cls}">${n} ${text}</span>` : "");
  return `
    <div class="compare-summary">
      ${part(summary.differ, "tag-warn", "differ")}
      ${part(summary["source-only"], "tag-src", "source only")}
      ${part(summary["dest-only"], "tag-dst", "destination only")}
      ${part(summary.match, "tag-ok", "match")}
      <span class="hint">${summary.total} settings in total</span>
    </div>
  `;
}

// Words that read better in capitals than in sentence case.
const ACRONYMS = new Map(
  ["amsi", "tls", "ssl", "url", "urls", "usb", "dlp", "ips", "http", "https", "dns", "ip", "id", "api", "cpu", "mtd", "hmpa", "aap", "edr", "xdr", "mdr", "ntp", "vpn", "os"]
    .map((w) => [w, w.toUpperCase()]),
);

function words(slug) {
  return String(slug)
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => ACRONYMS.get(w.toLowerCase()) ?? w.toLowerCase());
}

function sentence(slug) {
  const w = words(slug);
  if (!w.length) return "";
  const first = w[0] === w[0].toUpperCase() && w[0].length > 1 ? w[0] : w[0].charAt(0).toUpperCase() + w[0].slice(1);
  return [first, ...w.slice(1)].join(" ");
}

/**
 * Turn a setting path into a section and a readable label.
 * ["endpoint.threat-protection.malware-protection.scheduled-scan.time", "value"]
 *   -> { section: "Malware protection", label: "Scheduled scan time" }
 * The endpoint.<policy>. prefix is dropped; the raw key stays available.
 */
export function describePath(path) {
  const key = path[0] ?? "";
  const sub = path.slice(1);
  if (sub[0] === "value") sub.shift();
  let segs = key.split(".");
  if (segs[0] === "endpoint" && segs.length > 2) segs = segs.slice(2);
  const section = segs.length > 1 ? sentence(segs[0]) : "General";
  const rest = (segs.length > 1 ? segs.slice(1) : segs).concat(sub);
  const parts = rest.map((seg) => words(seg).join(" "));
  // Fold a trailing "enabled" into the part before it: "Deep learning enabled".
  if (parts.length > 1 && parts[parts.length - 1] === "enabled") {
    parts[parts.length - 2] += " enabled";
    parts.pop();
  }
  const label = parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(" · ");
  return { section, label: label || section, rawKey: sub.length ? `${key} › ${sub.join(".")}` : key };
}

/**
 * Render the side-by-side comparison as one table grouped by section.
 */
export function renderCompareTable(entries, options = {}) {
  const { showOnlyDiffs = true, filter = "" } = options;
  const filterLower = filter.toLowerCase();

  let rows = entries.map((e) => ({ ...e, ...describePath(e.path) }));
  if (showOnlyDiffs) {
    rows = rows.filter((e) => e.status !== "match");
  }
  if (filterLower) {
    rows = rows.filter((e) =>
      e.path.join(".").toLowerCase().includes(filterLower) ||
      e.label.toLowerCase().includes(filterLower) ||
      e.section.toLowerCase().includes(filterLower),
    );
  }

  if (rows.length === 0) {
    if (showOnlyDiffs && entries.length > 0 && !filterLower) {
      return `<div class="empty-state">No differences. Source and destination match on all ${entries.length} settings.</div>`;
    }
    return `<div class="empty-state">No settings match the current filter.</div>`;
  }

  const sections = new Map();
  for (const r of rows) {
    if (!sections.has(r.section)) sections.set(r.section, []);
    sections.get(r.section).push(r);
  }
  const sortedSections = [...sections.keys()].sort((a, b) =>
    a === "General" ? 1 : b === "General" ? -1 : a.localeCompare(b),
  );

  const bodies = sortedSections.map((name) => {
    const list = sections.get(name).sort((a, b) => a.label.localeCompare(b.label));
    const counts = summarizeEntries(list);
    const body = list.map(renderRow).join("");
    return `
      <tbody>
        <tr class="compare-section"><th colspan="4"><span>${escapeHtml(name)}</span><span class="hint">${escapeHtml(compactSummary(counts))}</span></th></tr>
        ${body}
      </tbody>`;
  }).join("");

  return `
    <table class="data-table compare-table">
      <thead>
        <tr>
          <th>Setting</th>
          <th><span class="side-title">Source</span></th>
          <th><span class="side-title is-dest">Destination</span></th>
          <th>Status</th>
        </tr>
      </thead>
      ${bodies}
    </table>`;
}

function renderRow(e) {
  const pillClass = STATUS_PILL_CLASS[e.status];
  const differ = e.status === "differ";
  return `
    <tr class="compare-row compare-row-${e.status}">
      <td class="compare-path" title="${escapeAttr(e.rawKey)}">
        <span class="set-label">${escapeHtml(e.label)}</span>
        <code class="set-key">${escapeHtml(e.rawKey)}</code>
      </td>
      <td class="compare-cell">${renderValue(e.source, e.status === "dest-only", differ ? "before" : "")}</td>
      <td class="compare-cell">${renderValue(e.dest, e.status === "source-only", differ ? "after" : "")}</td>
      <td class="compare-status"><span class="tag ${pillClass}">${escapeHtml(STATUS_LABEL[e.status])}</span></td>
    </tr>`;
}

function compactSummary(counts) {
  const parts = [];
  if (counts.differ) parts.push(`${counts.differ} differ`);
  if (counts["source-only"]) parts.push(`${counts["source-only"]} source only`);
  if (counts["dest-only"]) parts.push(`${counts["dest-only"]} destination only`);
  if (counts.match) parts.push(`${counts.match} match`);
  return parts.join(" · ") || `${counts.total} settings`;
}

export function renderValue(v, missing, role = "") {
  const cls = role ? ` chip-${role}` : "";
  if (missing || v === undefined) {
    return `<span class="compare-missing">not set</span>`;
  }
  if (v === null) {
    return `<span class="chip${cls}">null</span>`;
  }
  if (typeof v === "boolean") {
    return `<span class="chip chip-bool chip-${v ? "on" : "off"}${cls}">${v ? "On" : "Off"}</span>`;
  }
  if (typeof v === "number") {
    return `<span class="chip${cls} tnum">${v}</span>`;
  }
  if (typeof v === "string") {
    if (!v) return `<span class="chip chip-empty${cls}">empty</span>`;
    return `<span class="chip${cls}">${escapeHtml(v)}</span>`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return `<span class="chip chip-empty${cls}">none</span>`;
    if (v.every((x) => x === null || typeof x !== "object")) {
      return v.map((x) => `<span class="chip${cls}">${formatPrimitive(x)}</span>`).join(" ");
    }
    return `<span class="chip compare-collapsible${cls}" title="${escapeAttr(JSON.stringify(v, null, 2))}">${v.length} items</span>`;
  }
  return `<span class="chip compare-collapsible${cls}" title="${escapeAttr(JSON.stringify(v, null, 2))}">${Object.keys(v).length} keys</span>`;
}

function formatPrimitive(v) {
  if (v === null) return "null";
  return escapeHtml(String(v));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
