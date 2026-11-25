import { describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { receiptOf } from './live-receipt.ts';

type Value = NonNullable<ScanOutcome['value']>;
const value = (more: Partial<Value>): Value => ({
  input: 'balance',
  label: 'Balance',
  before: 42.5,
  after: 30.5,
  goal: null,
  format: 'currency',
  currency: 'USD',
  ...more,
});
const out = (kind: 'take' | 'add' | 'set' | 'use_up' | 'check_in', v: Value | null) => ({
  kind: 'ok' as const,
  action: { id: kind, label: kind, kind },
  value: v,
});
const reward = (label: string) => [{ id: 'take', rewardLabel: label } as ResolvedScanAction];

describe('the customer receipt of a committed scan', () => {
  it('says what was paid and the balance left', () => {
    expect(receiptOf(out('take', value({})), [])).toEqual({
      headline: 'Paid $12.00',
      sub: 'Balance $30.50',
      balance: true,
    });
  });

  it('says what was added and the balance now', () => {
    expect(receiptOf(out('add', value({ before: 10, after: 30 })), [])).toEqual({
      headline: 'Added $20.00',
      sub: 'Balance $30.00',
      balance: true,
    });
  });

  it('counts stamps against the goal with real plural forms', () => {
    const stamps = value({ input: 'stamps', label: 'Stamps', format: 'number', goal: 10 });
    const at = (before: number, after: number, goal: number | null = 10) =>
      receiptOf(out('add', { ...stamps, before, after, goal }), [], 'stamps');
    expect(at(7, 9)).toEqual({ headline: '+2 stamps', sub: '9 of 10' });
    expect(at(8, 9)?.headline).toBe('+1 stamp');
    expect(at(9, 9)?.headline).toBe('+0 stamps');
    expect(at(7, 9, null)).toEqual({ headline: '+2 stamps', sub: null });
  });

  it('reads another counter under its own label, as written', () => {
    const counter = (label: string, before: number, after: number) =>
      receiptOf(
        out('add', value({ input: 'c', label, format: 'number', before, after })),
        [],
        'stamps',
      )?.headline;
    expect(counter('Glasses', 0, 2)).toBe('Glasses +2');
    expect(counter('Glasses', 0, 1)).toBe('Glasses +1');
    expect(counter('Coffee', 0, 1)).toBe('Coffee +1');
    expect(counter('Visits', 3, 3)).toBe('Visits +0');
  });

  it('names the reward of a take that has one, and redeemed for a take that has none', () => {
    const count = value({ format: 'number', before: 10, after: 0, goal: 10 });
    expect(receiptOf(out('take', count), reward('Free coffee'))).toEqual({
      headline: 'Enjoy your reward',
      sub: 'Free coffee',
    });
    expect(receiptOf(out('take', count), [])).toEqual({ headline: 'Redeemed', sub: null });
  });

  it('says redeemed for use up and updated for a set, with no value needed', () => {
    expect(receiptOf(out('use_up', null), [])).toEqual({ headline: 'Redeemed', sub: null });
    expect(receiptOf(out('set', value({ before: 1, after: 5 })), [])).toEqual({
      headline: 'Updated',
      sub: null,
    });
  });

  it('leaves a check-in, a refusal and an unreadable value to the system words', () => {
    expect(receiptOf(out('check_in', null), [])).toBeNull();
    expect(receiptOf({ ...out('take', value({})), kind: 'refused' as never }, [])).toBeNull();
    expect(receiptOf(out('take', value({ before: null })), [])).toBeNull();
    expect(receiptOf(out('add', null), [])).toBeNull();
  });
});
