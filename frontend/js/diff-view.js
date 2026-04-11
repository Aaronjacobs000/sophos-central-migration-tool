/**
 * Side-by-side compare renderer for policy settings.
 *
 * The backend already returns the full source and dest objects plus a flat
 * change list. This module ignores the change list and walks the union of
 * leaf paths, producing rows that the UI groups by top-level key.
 */

const STATUS_LABEL = {
  match: "match",
  differ: "differs",
  "source-only": "source only",
  "dest-only": "dest only",
};

const STATUS_PILL_CLASS = {
  match: "compare-pill-match",
  differ: "compare-pill-differ",
  "source-only": "compare-pill-source",
  "dest-only": "compare-pill-dest",
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
 * Render the summary pills shown above the comparison table.
 */
export function renderCompareSummary(summary) {
  return `
    <div class="compare-summary">
      <span class="compare-pill compare-pill-differ">${summary.differ} differ</span>
      <span class="compare-pill compare-pill-source">${summary["source-only"]} source only</span>
      <span class="compare-pill compare-pill-dest">${summary["dest-only"]} dest only</span>
      <span class="compare-pill compare-pill-match">${summary.match} match</span>
      <span class="hint" style="margin-left:0.5rem;">${summary.total} settings total</span>
    </div>
  `;
}

/**
 * Render the side-by-side comparison table, grouped by top-level key.
 */
export function renderCompareTable(entries, options = {}) {
  const { showOnlyDiffs = true, filter = "" } = options;
  const filterLower = filter.toLowerCase();

  let filtered = entries;
  if (showOnlyDiffs) {
    filtered = filtered.filter((e) => e.status !== "match");
  }
  if (filterLower) {
    filtered = filtered.filter((e) =>
      e.path.join(".").toLowerCase().includes(filterLower),
    );
  }

  if (filtered.length === 0) {
    if (showOnlyDiffs && entries.length > 0) {
      return `<div class="empty-state">No differences. Source and destination match for all ${entries.length} settings.</div>`;
    }
    return `<div class="empty-state">No settings match the current filter.</div>`;
  }

  const groups = groupByTopKey(filtered);
  const sortedKeys = [...groups.keys()].sort();

  return sortedKeys
    .map((key) => renderGroup(key, groups.get(key)))
    .join("");
}

function renderGroup(topKey, entries) {
  const counts = summarizeEntries(entries);
  const summary = compactSummary(counts);

  const rows = entries
    .map((e) => {
      const pathLabel = e.path.slice(1).join(".") || "(value)";
      const fullPath = e.path.join(".");
      const sourceCell = renderValue(e.source, e.status === "dest-only");
      const destCell = renderValue(e.dest, e.status === "source-only");
      const pillClass = STATUS_PILL_CLASS[e.status];
      const rowClass = `compare-row compare-row-${e.status}`;
      return `
        <tr class="${rowClass}">
          <td class="compare-path" title="${escapeAttr(fullPath)}">${escapeHtml(pathLabel)}</td>
          <td class="compare-cell compare-cell-source">${sourceCell}</td>
          <td class="compare-cell compare-cell-dest">${destCell}</td>
          <td class="compare-status"><span class="compare-pill ${pillClass}">${escapeHtml(STATUS_LABEL[e.status])}</span></td>
        </tr>`;
    })
    .join("");

  return `
    <section class="compare-group">
      <header class="compare-group-header">
        <h3>${escapeHtml(topKey)}</h3>
        <span class="hint">${escapeHtml(summary)}</span>
      </header>
      <table class="data-table compare-table">
        <thead>
          <tr>
            <th>Setting</th>
            <th>Source</th>
            <th>Destination</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function compactSummary(counts) {
  const parts = [];
  if (counts.differ) parts.push(`${counts.differ} differ`);
  if (counts["source-only"]) parts.push(`${counts["source-only"]} source only`);
  if (counts["dest-only"]) parts.push(`${counts["dest-only"]} dest only`);
  if (counts.match) parts.push(`${counts.match} match`);
  return parts.join(" · ") || `${counts.total} settings`;
}

function renderValue(v, missing) {
  if (missing || v === undefined) {
    return `<span class="compare-missing">—</span>`;
  }
  if (v === null) {
    return `<code class="compare-value">null</code>`;
  }
  if (typeof v === "boolean") {
    const cls = v ? "compare-bool-true" : "compare-bool-false";
    return `<code class="compare-value ${cls}">${v}</code>`;
  }
  if (typeof v === "number") {
    return `<code class="compare-value">${v}</code>`;
  }
  if (typeof v === "string") {
    if (!v) return `<code class="compare-value compare-empty">""</code>`;
    return `<code class="compare-value">${escapeHtml(v)}</code>`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return `<code class="compare-value compare-empty">[]</code>`;
    if (v.every((x) => x === null || typeof x !== "object")) {
      return `<code class="compare-value">[${v.map((x) => formatPrimitive(x)).join(", ")}]</code>`;
    }
    return `<code class="compare-value compare-collapsible" title="${escapeAttr(JSON.stringify(v, null, 2))}">[${v.length} items]</code>`;
  }
  // object fallback (shouldn't happen — we recurse into objects)
  return `<code class="compare-value compare-collapsible" title="${escapeAttr(JSON.stringify(v, null, 2))}">{${Object.keys(v).length} keys}</code>`;
}

function formatPrimitive(v) {
  if (v === null) return "null";
  if (typeof v === "string") return `"${escapeHtml(v)}"`;
  return String(v);
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
