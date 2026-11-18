import { describe, expect, it } from 'vitest';
import { SCAN_STAMPS_MAX } from '../../stamps/layout.ts';
import type { Json, TemplateManifest } from '../../types.ts';
import type { ScanDisplayDoc } from './schema.ts';
import { actionGoals } from './scope.ts';
import { renderDoc, scopeOf } from './test-kit.ts';

const progress = (stamps: number, goal: number, extra: object = {}) =>
  renderDoc(
    {
      v: 1,
      header: {},
      panels: [
        {
          id: 'p_a',
          rows: [{ id: 'r_p', type: 'progress', value: '{{inputs.stamps}}', goal, ...extra }],
        },
      ],
    } as ScanDisplayDoc,
    scopeOf({ stamps }),
  ).panels[0]?.rows[0];

describe('a stamp card on the scanner', () => {
  it('says what is saved beside the reward ready', () => {
    expect(progress(12, 10)).toMatchObject({ rewards: 1, caption: '1 reward ready · 2 saved' });
    expect(progress(10, 10)).toMatchObject({ rewards: 1, caption: '1 reward ready' });
    expect(progress(11, 5)).toMatchObject({ rewards: 2, caption: '2 rewards ready · 1 saved' });
  });

  it('draws discs up to the cap and a bar past it', () => {
    expect(progress(3, SCAN_STAMPS_MAX)).toMatchObject({ style: 'stamps', goal: SCAN_STAMPS_MAX });
    expect(progress(3, 12)).toMatchObject({ style: 'stamps' });
    expect(progress(3, SCAN_STAMPS_MAX + 1)).toMatchObject({ style: 'bar' });
    expect(progress(3, 12, { style: 'bar' })).toMatchObject({ style: 'bar' });
  });

  it('takes its goal from the stamps block, not the action', () => {
    const manifest = {
      stamps: { input: 'stamps', goal: 14 },
      scan: {
        actions: [{ id: 'redeem', label: 'Redeem', kind: 'take', input: 'stamps', amount: 1 }],
      },
    } as unknown as TemplateManifest;
    expect(actionGoals(manifest)).toEqual({ stamps: { goal: 14 } });
  });
});

describe('a counter on the scanner', () => {
  const left = (n: number, goals: Record<string, Json>) =>
    renderDoc(
      {
        v: 1,
        header: {},
        panels: [{ id: 'p_a', rows: [{ id: 'r_p', type: 'progress', value: '{{inputs.left}}' }] }],
      } as ScanDisplayDoc,
      { ...scopeOf({ left: n }), goals },
    ).panels[0]?.rows[0];
  const goals = { left: { goal: 10, counter: true } };

  it('shows what is left out of its size, with no reward', () => {
    expect(left(7, goals)).toMatchObject({ value: 7, goal: 10, rewards: 0, caption: '7 left' });
    expect(left(10, goals)).toMatchObject({ rewards: 0, caption: '10 left' });
  });
  it('says None left at zero', () => {
    expect(left(0, goals)).toMatchObject({ value: 0, caption: 'None left' });
  });
});
