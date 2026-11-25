import type { EntitlementImpact, ImpactKind } from '../entitlement-impact.ts';

/** `{n}` is the count of features the change moves in that way. */
export const IMPACT_LABEL: Record<ImpactKind, (n: number) => string> = {
  off: (n) => `${n} ${n === 1 ? 'turns' : 'turn'} off`,
  down: (n) => `${n} lowered`,
  on: (n) => `${n} ${n === 1 ? 'turns' : 'turn'} on`,
  up: (n) => `${n} raised`,
  changed: (n) => `${n} changed`,
};

export const IMPACT_ORDER: readonly ImpactKind[] = ['off', 'down', 'on', 'up', 'changed'];

export const FEATURES_KEPT = 'Nothing is deleted.';
export const NO_FEATURE_CHANGE = 'No feature changes.';

/** "Changes 5 features: 3 turn off, 2 lowered." */
export function impactSentence(impact: EntitlementImpact): string {
  const total = impact.changes.length;
  if (total === 0) return NO_FEATURE_CHANGE;
  const parts = IMPACT_ORDER.filter((k) => impact.counts[k] > 0).map((k) =>
    IMPACT_LABEL[k](impact.counts[k]),
  );
  return `Changes ${total} ${total === 1 ? 'feature' : 'features'}: ${parts.join(', ')}.`;
}
