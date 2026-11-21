import { expect, it } from 'vitest';
import { currentStep, stepDone } from './first-pass-state.ts';

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
])('puts %j on step %s', (counts, step) => {
  expect(currentStep(setup(counts))).toBe(step);
});

it('checks the steps before the current one, and all of them when done', () => {
  const s = setup({ assignedTemplates: 1 });
  expect(['blueprint', 'try', 'release'].map((id) => stepDone(s, id as never))).toEqual([
    true,
    false,
    false,
  ]);
  const all = setup({ assignedTemplates: 1, walletPasses: 1, releasedTemplates: 1 });
  expect(stepDone(all, 'release')).toBe(true);
});
