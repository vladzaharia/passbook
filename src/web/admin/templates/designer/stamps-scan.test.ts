import { describe, expect, it } from 'vitest';
import { applyOp } from './apply.ts';
import { sampleDoc } from './fixtures.ts';
import { setGoal } from './stamps.ts';

describe('a stamp card with a scan block', () => {
  it('follows the goal with its redeem, and leaves the add as it is', () => {
    const doc = sampleDoc();
    const base = applyOp(doc, { op: 'stamps-add', art: {} as never });
    const manifest = structuredClone(base.manifest) as { scan?: unknown };
    manifest.scan = {
      actions: [
        { id: 'stamp', label: 'Add stamp', kind: 'add', input: 'stamps', amount: 1 },
        { id: 'redeem', label: 'Redeem reward', kind: 'take', input: 'stamps', amount: 10 },
      ],
    };
    const next = setGoal({ ...base, manifest: manifest as never }, 14);
    const actions = (next.manifest.scan as { actions: { amount: number }[] }).actions;
    expect(actions.map((a) => a.amount)).toEqual([1, 14]);
  });
});
