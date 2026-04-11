/**
 * Tiny structural deep-diff. Returns a flat list of changes between two
 * JSON-shaped values.
 *
 * Rules:
 *   - Plain objects: key-wise recursion.
 *   - Arrays of objects with `id` keys: matched by id, then recursed.
 *   - Other arrays: compared as multisets (order-insensitive) for primitives,
 *     index-wise otherwise.
 *   - Primitives: strict deep-equal compare.
 */

export type Change =
  | { op: "add"; path: string[]; value: unknown }
  | { op: "remove"; path: string[]; value: unknown }
  | { op: "change"; path: string[]; from: unknown; to: unknown };

export function diff(a: unknown, b: unknown): Change[] {
  const out: Change[] = [];
  walk(a, b, [], out);
  return out;
}

function walk(a: unknown, b: unknown, path: string[], out: Change[]): void {
  if (deepEqual(a, b)) return;

  // Mismatched kinds → record as a change.
  if (kind(a) !== kind(b)) {
    out.push({ op: "change", path, from: a, to: b });
    return;
  }

  if (a && typeof a === "object" && !Array.isArray(a)) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const k of keys) {
      const inA = Object.prototype.hasOwnProperty.call(aObj, k);
      const inB = Object.prototype.hasOwnProperty.call(bObj, k);
      if (inA && !inB) {
        out.push({ op: "remove", path: [...path, k], value: aObj[k] });
      } else if (!inA && inB) {
        out.push({ op: "add", path: [...path, k], value: bObj[k] });
      } else {
        walk(aObj[k], bObj[k], [...path, k], out);
      }
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    diffArray(a, b, path, out);
    return;
  }

  // Primitives
  out.push({ op: "change", path, from: a, to: b });
}

function diffArray(a: unknown[], b: unknown[], path: string[], out: Change[]): void {
  // Array of objects with shared `id` field — match by id.
  if (a.every(hasId) && b.every(hasId)) {
    const aMap = new Map(a.map((x) => [(x as { id: unknown }).id, x]));
    const bMap = new Map(b.map((x) => [(x as { id: unknown }).id, x]));
    const ids = new Set([...aMap.keys(), ...bMap.keys()]);
    for (const id of ids) {
      const av = aMap.get(id);
      const bv = bMap.get(id);
      if (av === undefined) {
        out.push({ op: "add", path: [...path, `[id=${String(id)}]`], value: bv });
      } else if (bv === undefined) {
        out.push({ op: "remove", path: [...path, `[id=${String(id)}]`], value: av });
      } else {
        walk(av, bv, [...path, `[id=${String(id)}]`], out);
      }
    }
    return;
  }

  // Arrays of primitives — multiset compare.
  if (a.every(isPrimitive) && b.every(isPrimitive)) {
    const aCounts = countMap(a);
    const bCounts = countMap(b);
    const keys = new Set([...aCounts.keys(), ...bCounts.keys()]);
    for (const k of keys) {
      const aN = aCounts.get(k) ?? 0;
      const bN = bCounts.get(k) ?? 0;
      if (aN === bN) continue;
      if (aN > bN) {
        out.push({ op: "remove", path: [...path, `[${k}]`], value: k });
      } else {
        out.push({ op: "add", path: [...path, `[${k}]`], value: k });
      }
    }
    return;
  }

  // Fallback — index-wise compare.
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i >= a.length) {
      out.push({ op: "add", path: [...path, `[${i}]`], value: b[i] });
    } else if (i >= b.length) {
      out.push({ op: "remove", path: [...path, `[${i}]`], value: a[i] });
    } else {
      walk(a[i], b[i], [...path, `[${i}]`], out);
    }
  }
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isPrimitive(v: unknown): boolean {
  return v === null || (typeof v !== "object");
}

function hasId(v: unknown): v is { id: unknown } {
  return !!v && typeof v === "object" && "id" in (v as object);
}

function countMap(arr: unknown[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of arr) {
    const k = String(v);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    const ar = a as unknown[];
    const br = b as unknown[];
    if (ar.length !== br.length) return false;
    for (let i = 0; i < ar.length; i++) if (!deepEqual(ar[i], br[i])) return false;
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = Object.keys(aObj);
  if (keys.length !== Object.keys(bObj).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

export function summarize(changes: Change[]): { added: number; removed: number; changed: number } {
  let added = 0,
    removed = 0,
    changed = 0;
  for (const c of changes) {
    if (c.op === "add") added++;
    else if (c.op === "remove") removed++;
    else changed++;
  }
  return { added, removed, changed };
}
