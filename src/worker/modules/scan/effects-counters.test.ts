import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { ScanEffectStop, valueEffect } from './effects-value.ts';

const manifest = (maximum?: number) =>
  ({
    schema: 1,
    name: 'Pack',
    inputs: {
      type: 'object',
      properties: {
        uses: { type: 'integer', minimum: 0, default: 10, ...(maximum ? { maximum } : {}) },
      },
    },
    counters: { uses: { input: 'uses', size: 10 } },
  }) as unknown as TemplateManifest;
const act = (kind: 'add' | 'take', amount: number) =>
  ({ id: kind, kind, input: 'uses', amount }) as unknown as ResolvedScanAction;
const run = (m: TemplateManifest, a: ResolvedScanAction, uses?: number) =>
  valueEffect(a, m, { personalization: uses === undefined ? {} : { uses }, status: 'active' }, {});

describe('a counter at the scanner', () => {
  it('refills on top of what is left', () => {
    expect(run(manifest(), act('add', 10), 3).after).toBe(13);
  });
  it('refuses a refill past the input maximum instead of losing uses', () => {
    expect(() => run(manifest(10), act('add', 10), 3)).toThrow(ScanEffectStop);
    expect(run(manifest(20), act('add', 10), 3).after).toBe(13);
  });
  it('uses one, and refuses at none left', () => {
    expect(run(manifest(), act('take', 1), 1).after).toBe(0);
    expect(() => run(manifest(), act('take', 1), 0)).toThrow(ScanEffectStop);
  });
  it('reads a missing value as its default, as the pass does', () => {
    expect(run(manifest(), act('take', 1)).before).toBe(10);
  });
});
