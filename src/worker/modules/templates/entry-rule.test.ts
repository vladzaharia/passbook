import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { entryRuleOf } from './entry-rule.ts';

const manifest = (scan: unknown) => ({ scan }) as unknown as TemplateManifest;
const CHECK_IN = { id: 'in', label: 'Check in', kind: 'check_in' };

describe('entryRuleOf', () => {
  it('reads the template default', () => {
    expect(
      entryRuleOf(
        manifest({
          actions: [CHECK_IN],
          checkIn: { mode: 'unlimited', days: 1, durationFrom: 'first_scan' },
        }),
      ),
    ).toEqual({
      mode: 'unlimited',
      days: 1,
      durationMinutes: null,
      durationFrom: 'first_scan',
      plans: [],
      source: 'template',
    });
  });
  it('falls back to the action repeat, and is null without a check-in', () => {
    expect(entryRuleOf(manifest({ actions: [{ ...CHECK_IN, repeat: 'once' }] }))).toMatchObject({
      mode: 'single',
      source: 'action',
    });
    expect(
      entryRuleOf(manifest({ actions: [{ id: 'x', label: 'Use', kind: 'use_up' }] })),
    ).toBeNull();
  });
});
