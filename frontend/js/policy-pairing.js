// Which destination policy a source policy pairs with. A copy of
// backend/src/compare/policy-pairing.ts, which the deep match, Compare and the
// policy clone use, so the policy the Policies page ticks is the one they use.
//
// Only policies of the same type pair. The exact name wins. Failing that, a
// name that matches ignoring case and surrounding spaces pairs, but only one
// to one: when more than one policy on either side has that name, none is
// picked. A policy whose exact name is on the other side is already paired
// and takes no part.

const fold = (name) => name.trim().toLowerCase();

/** { dest, ambiguous }: the destination policy or null, and whether more than one matched ignoring case. */
export function pairPolicy(source, sources, dests) {
  const srcs = sources.filter((p) => p.type === source.type && p.id !== source.id).concat(source);
  const dsts = dests.filter((p) => p.type === source.type);
  const exact = dsts.find((d) => d.name === source.name);
  if (exact) return { dest: exact, ambiguous: false };

  const key = fold(source.name);
  const candidates = (list, other) =>
    list.filter((p) => fold(p.name) === key && !other.some((o) => o.name === p.name));
  const destCandidates = candidates(dsts, srcs);
  const sourceCandidates = candidates(srcs, dsts);
  if (destCandidates.length === 1 && sourceCandidates.length === 1) {
    return { dest: destCandidates[0], ambiguous: false };
  }
  return { dest: null, ambiguous: destCandidates.length > 0 };
}
