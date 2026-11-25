/** What one target of one subject looks like: Polaris ID (`present`), the binding (`grant`), D1 (`wanted`, `held`). */
export interface TargetFacts {
  /** The subject is in the group in Polaris ID. */
  present: boolean;
  /** The binding has a live grant: PassBook added it. */
  grant: boolean;
  /** A live reason in D1 wants it. A disabled user and a platform admin want nothing. */
  wanted: boolean;
  /** The owner removed it once; only Restore adds it again. */
  held: boolean;
  /**
   * PassBook has seen the subject in the group. A live grant that is absent now was then taken by the owner;
   * without it the grant may be a write whose answer was lost, which is applied again, never held.
   */
  seen: boolean;
}

/**
 * - `ok`: as wanted, nothing to do.
 * - `add`: wanted, absent, no grant, not held: PassBook adds it.
 * - `remove`: PassBook added it and nothing wants it any more.
 * - `settle`: a grant for a role that is gone and unwanted: the binding ends it, no group write.
 * - `hold`: the owner removed a role PassBook added and still wants. Held, sessions revoked, never re-added.
 * - `held`: already held; nothing to do.
 * - `external`: present without a PassBook grant: the owner's, never removed by automation.
 * - `none`: absent, no grant and unwanted.
 */
export type Verdict = 'ok' | 'add' | 'remove' | 'settle' | 'hold' | 'held' | 'external' | 'none';

/** The owner-wins table (design 1 section 3.5), shared by the drain and the daily reconcile. */
export function classify(f: TargetFacts): Verdict {
  if (f.present) {
    if (!f.grant) return 'external';
    return f.wanted ? 'ok' : 'remove';
  }
  if (f.held) return f.grant && !f.wanted ? 'settle' : 'held';
  if (f.grant) {
    if (!f.wanted) return 'settle';
    return f.seen ? 'hold' : 'add';
  }
  return f.wanted ? 'add' : 'none';
}

/** The presence to record for a target, from what Polaris ID and the binding say. */
export const presenceOf = (f: Pick<TargetFacts, 'present' | 'grant'>) =>
  f.present ? (f.grant ? ('passbook' as const) : ('external' as const)) : ('none' as const);
