import { expect, it } from 'vitest';
import { currentStep, progress, stepDone } from './first-pass-state.ts';

const setup = (over: Record<string, number> = {}) => ({
  orgs: 1,
  assignedTemplates: 0,
  passes: 0,
  approvedTemplates: 0,
  releasedTemplates: 0,
  walletPasses: 0,
  passEmailsSent: 0,
  latestPassId: null,
  scanners: 0,
  ...over,
});

it.each([
  [{}, 'blueprint'],
  [{ assignedTemplates: 1 }, 'try'],
  [{ assignedTemplates: 1, passes: 1, approvedTemplates: 1 }, 'try'],
  [{ assignedTemplates: 1, walletPasses: 1 }, 'release'],
  [{ assignedTemplates: 1, walletPasses: 1, releasedTemplates: 1 }, null],
  [{ assignedTemplates: 1, releasedTemplates: 1 }, null],
])('puts %j on step %s', (counts, step) => {
  expect(currentStep(setup(counts))).toBe(step);
});

it('checks each step by its own count', () => {
  const ids = ['blueprint', 'try', 'release'] as const;
  expect(ids.map((id) => stepDone(setup({ assignedTemplates: 1 }), id))).toEqual([
    true,
    false,
    false,
  ]);
  expect(
    ids.map((id) => stepDone(setup({ assignedTemplates: 1, releasedTemplates: 1 }), id)),
  ).toEqual([true, false, true]);
});

it('counts progress', () => {
  expect(progress(setup())).toBe(0);
  expect(progress(setup({ assignedTemplates: 1, walletPasses: 1 }))).toBe(2);
});
