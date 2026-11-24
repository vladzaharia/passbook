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

  it('counts stamps against the goal, and a plain counter without one', () => {
    const stamps = value({ label: 'Stamps', format: 'number', before: 7, after: 9, goal: 10 });
    expect(receiptOf(out('add', stamps), [])).toEqual({ headline: '+2 stamps', sub: '9 of 10' });
    const one = { ...stamps, before: 8, after: 9 };
    expect(receiptOf(out('add', one), [])?.headline).toBe('+1 stamp');
    expect(receiptOf(out('add', { ...stamps, goal: null }), [])).toEqual({
      headline: '+2 stamps',
      sub: null,
    });
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
