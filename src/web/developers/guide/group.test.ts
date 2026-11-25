import { describe, expect, it } from 'vitest';
import { DEV_GUIDE_STEPS, DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { groupByStep, stepOf } from './group.ts';
import { GUIDE_ICONS } from './icons.ts';

describe('guide steps', () => {
  it('gives every guide a known step and its own icon', () => {
    const ids = DEV_GUIDE_STEPS.map((s) => s.id) as string[];
    for (const g of DEV_GUIDES) {
      expect(ids, g.id).toContain(g.step);
      expect(GUIDE_ICONS[g.id], g.id).toBeDefined();
    }
    expect(new Set(Object.values(GUIDE_ICONS)).size).toBe(DEV_GUIDES.length);
  });

  it('groups in journey order, keeping the copy order within a step', () => {
    const shuffled = [...DEV_GUIDES].reverse().map((g) => ({ id: g.id }));
    const groups = groupByStep(shuffled, (g) => g.id);
    expect(groups.map((g) => g.step.label)).toEqual([
      'Start',
      'Issue',
      'Change',
      'At the door',
      'Connect',
      'Launch',
    ]);
    expect(groups[0]?.items.map((g) => g.id)).toEqual([
      'org-setup',
      'release-a-template',
      'test-mode',
    ]);
  });

  it('puts an unknown guide in the first step', () => {
    expect(stepOf('nope').id).toBe('start');
  });
});
