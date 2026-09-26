/**
 * Which destination policy a source policy pairs with. The deep match, the
 * Compare route and the policy clone all use this rule, and the Policies page
 * has a copy of it (frontend/js/policy-pairing.js), so the policy the page
 * ticks is the one Compare opens and an overwrite writes to.
 *
 * Only policies of the same type pair. The exact name wins. Failing that, a
 * name that matches ignoring case and surrounding spaces pairs, but only one
 * to one: when more than one policy on either side has that name, none is
 * picked. A policy whose exact name is on the other side is already paired
 * and takes no part.
 */

export interface NamedPolicy {
  id: string;
  name: string;
  type: string;
}

export interface PolicyPairing<T> {
  /** The destination policy, or null when there is none to pair with. */
  dest: T | null;
  /** True when more than one policy matches the name ignoring case, so none was picked. */
  ambiguous: boolean;
}

const fold = (name: string) => name.trim().toLowerCase();

export function pairPolicy<T extends NamedPolicy>(
  source: NamedPolicy,
  sources: NamedPolicy[],
  dests: T[],
): PolicyPairing<T> {
  const srcs = sources.filter((p) => p.type === source.type && p.id !== source.id).concat(source);
  const dsts = dests.filter((p) => p.type === source.type);
  const exact = dsts.find((d) => d.name === source.name);
  if (exact) return { dest: exact, ambiguous: false };

  const key = fold(source.name);
  const candidates = <P extends NamedPolicy>(list: P[], other: NamedPolicy[]) =>
    list.filter((p) => fold(p.name) === key && !other.some((o) => o.name === p.name));
  const destCandidates = candidates(dsts, srcs);
  const sourceCandidates = candidates(srcs, dsts);
  if (destCandidates.length === 1 && sourceCandidates.length === 1) {
    return { dest: destCandidates[0]!, ambiguous: false };
  }
  return { dest: null, ambiguous: destCandidates.length > 0 };
}
