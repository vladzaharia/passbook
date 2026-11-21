import type { MetricsOverview } from '@/shared/contracts/metrics.ts';

export type PathStep = 'blueprint' | 'try' | 'release';
export const PATH_STEPS: readonly { id: PathStep; label: string }[] = [
  { id: 'blueprint', label: 'Pick a blueprint' },
  { id: 'try', label: 'Try on your phone' },
  { id: 'release', label: 'Release' },
];

/** The step the organization is on, from counts across both modes; null once the path is done. */
export function currentStep(setup: MetricsOverview['setup']): PathStep | null {
  if (setup.assignedTemplates === 0) return 'blueprint';
  if (setup.walletPasses === 0) return 'try';
  if (setup.releasedTemplates === 0) return 'release';
  return null;
}

export const stepDone = (setup: MetricsOverview['setup'], id: PathStep): boolean => {
  const at = currentStep(setup);
  if (at === null) return true;
  return PATH_STEPS.findIndex((s) => s.id === id) < PATH_STEPS.findIndex((s) => s.id === at);
};

/** Blueprints dealt first, by their id's slug; any others follow in gallery order. */
export const FIRST_PASS_SLUGS = [
  'monthly-pass',
  'event-ticket',
  'coupon',
  'stamp-card',
  'store-card',
  'boarding-pass',
] as const;
