import type { MetricsOverview } from '@/shared/contracts/metrics.ts';

export type PathStep = 'blueprint' | 'try' | 'release';
export const PATH_STEPS: readonly { id: PathStep; label: string; done: string }[] = [
  { id: 'blueprint', label: 'Pick a blueprint', done: 'Blueprint' },
  { id: 'try', label: 'Try on your phone', done: 'On your phone' },
  { id: 'release', label: 'Release', done: 'Released' },
];

type Setup = MetricsOverview['setup'];

/** A step is done by its own count: a release without a phone leaves Try open but ends the path. */
export const stepDone = (setup: Setup, id: PathStep): boolean =>
  id === 'blueprint'
    ? setup.assignedTemplates > 0
    : id === 'try'
      ? setup.walletPasses > 0
      : setup.releasedTemplates > 0;

/** The step the organization is on, from counts across both modes; null once the path is done. */
export function currentStep(setup: Setup): PathStep | null {
  if (setup.assignedTemplates === 0) return 'blueprint';
  if (setup.releasedTemplates > 0) return null;
  return setup.walletPasses === 0 ? 'try' : 'release';
}

/** How far along: 0 to 3 steps done, for "did it advance since the last visit". */
export const progress = (setup: Setup): number =>
  PATH_STEPS.filter((s) => stepDone(setup, s.id)).length;

/** Blueprints dealt first, by their id's slug; any others follow in gallery order. */
export const FIRST_PASS_SLUGS = [
  'monthly-pass',
  'event-ticket',
  'coupon',
  'stamp-card',
  'store-card',
  'boarding-pass',
] as const;
