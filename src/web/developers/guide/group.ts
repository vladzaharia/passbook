import { DEV_GUIDE_STEPS, DEV_GUIDES } from '../../../shared/copy/developers.ts';

type StepDef = (typeof DEV_GUIDE_STEPS)[number];

/** The step a guide sits in; a guide missing from the copy reads as the first step. */
export function stepOf(id: string): StepDef {
  const step = DEV_GUIDES.find((g) => g.id === id)?.step;
  return DEV_GUIDE_STEPS.find((s) => s.id === step) ?? (DEV_GUIDE_STEPS[0] as StepDef);
}

/** Items grouped by step, in journey order and, within a step, in the copy's order. Empty steps drop out. */
export function groupByStep<T>(items: readonly T[], idOf: (item: T) => string) {
  const rank = (id: string) => {
    const i = DEV_GUIDES.findIndex((g) => g.id === id);
    return i < 0 ? DEV_GUIDES.length : i;
  };
  const sorted = [...items].sort((a, b) => rank(idOf(a)) - rank(idOf(b)));
  return DEV_GUIDE_STEPS.map((step) => ({
    step: step as StepDef,
    items: sorted.filter((it) => stepOf(idOf(it)).id === step.id),
  })).filter((g) => g.items.length > 0);
}
