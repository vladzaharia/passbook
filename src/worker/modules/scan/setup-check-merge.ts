import type { Check } from '../../platform/authority-checks.ts';

/**
 * A check the one-call setup can fold: `ids` of the same `kind` union into one check, and a check
 * with only a `kind` counts once. One grant row carries every object's checks and has a bind budget,
 * so the same check from many plans must not repeat.
 */
export type MergeableCheck = Check & { merge?: { kind: string; ids?: readonly string[] } };

export const tagged = (check: Check, kind: string, ids?: readonly string[]): MergeableCheck =>
  Object.assign(check, { merge: { kind, ...(ids ? { ids } : {}) } });

/** Folds checks by their `merge` tag; `rebuild` makes the one check for the union of a kind's ids. */
export function foldChecks(
  checks: readonly MergeableCheck[],
  rebuild: (kind: string, ids: string[]) => Check[] | null,
): Check[] {
  const out: Check[] = [];
  const unions = new Map<string, Set<string>>();
  const once = new Set<string>();
  for (const c of checks) {
    const m = c.merge;
    if (!m) out.push(c);
    else if (m.ids) {
      const set = unions.get(m.kind) ?? new Set<string>();
      for (const id of m.ids) set.add(id);
      unions.set(m.kind, set);
    } else if (!once.has(m.kind)) {
      once.add(m.kind);
      out.push(c);
    }
  }
  for (const [kind, ids] of unions) out.push(...(rebuild(kind, [...ids]) ?? []));
  return out;
}
