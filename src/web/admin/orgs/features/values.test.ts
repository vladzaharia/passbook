import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_KEYS, presetValues } from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import { draftOf, valueFromDraft } from './value-field.tsx';
import { FEATURE_GROUPS, formatValue, isOff, resolved } from './values.ts';

describe('feature groups', () => {
  it('hold every registry key exactly once, each with a label', () => {
    const keys = FEATURE_GROUPS.flatMap((g) => [...g.keys]);
    expect([...keys].sort()).toEqual([...ENTITLEMENT_KEYS].sort());
    for (const key of keys) expect(ENTITLEMENT_LABEL[key]).toBeTruthy();
  });
});

describe('formatValue', () => {
  it('reads each kind in words', () => {
    expect(formatValue('print', 1)).toBe('On');
    expect(formatValue('print', 0)).toBe('Off');
    expect(formatValue('api', 'read')).toBe('Read only');
    expect(formatValue('passes.live', null)).toBe('No limit');
    expect(formatValue('passes.live', 0)).toBe('Off');
    expect(formatValue('passes.live', 5000)).toBe('5,000');
    expect(formatValue('connectors', ['*'])).toBe('Any');
    expect(formatValue('connectors', ['csv-url', 'webhook-push/*'])).toBe(
      'csv-url, webhook-push/*',
    );
    expect(formatValue('templates.stylesBlocked', [])).toBe('None');
    expect(formatValue('print', undefined)).toBe('Off');
  });

  it('marks only a stopped feature as off', () => {
    expect(isOff('print', 0)).toBe(true);
    expect(isOff('nfc', 'off')).toBe(true);
    expect(isOff('nfc', 'basic')).toBe(false);
    expect(isOff('domains', 0)).toBe(true);
    expect(isOff('passes.live', null)).toBe(false);
  });
});

describe('resolved', () => {
  it('lets an override win only where the preset has the key', () => {
    const values = resolved(presetValues('trial'), {
      print: { value: 1, note: null, expiresAt: null },
    });
    expect(values.print).toBe(1);
    expect(values['wallet.samsung']).toBe(0);
  });
});

describe('value drafts', () => {
  it('reads a limit, a list and a level, and refuses what is not a value', () => {
    expect(valueFromDraft('passes.live', { ...draftOf('passes.live', 100), limit: 250 })).toEqual({
      value: 250,
    });
    expect(valueFromDraft('passes.live', { ...draftOf('passes.live', null) })).toEqual({
      value: null,
    });
    expect(
      valueFromDraft('passes.live', { ...draftOf('passes.live', 5), limit: -1 }),
    ).toHaveProperty('error');
    expect(
      valueFromDraft('passes.live', { ...draftOf('passes.live', 5), limit: 1.5 }),
    ).toHaveProperty('error');
    expect(
      valueFromDraft('connectors', { ...draftOf('connectors', ['*']), list: 'csv-url, x/*\n*' }),
    ).toEqual({ value: ['csv-url', 'x/*', '*'] });
    expect(
      valueFromDraft('connectors', { ...draftOf('connectors', ['*']), list: 'not valid!' }),
    ).toHaveProperty('error');
    expect(valueFromDraft('nfc', draftOf('nfc', 'basic'))).toEqual({ value: 'basic' });
    expect(valueFromDraft('print', draftOf('print', 1))).toEqual({ value: 1 });
  });
});
