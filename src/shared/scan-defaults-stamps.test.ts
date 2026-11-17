import { describe, expect, it } from 'vitest';
import { scanOf } from './scan-defaults.ts';

describe('scanOf on a stamp card', () => {
  const stamps = { input: 'stamps', goal: 12 } as never;
  const actions = [
    { id: 'stamp', label: 'Add stamp', kind: 'add', input: 'stamps' },
    { id: 'redeem', label: 'Redeem', kind: 'take', input: 'stamps' },
    { id: 'coupon', label: 'Coupon', kind: 'take', input: 'balance' },
  ] as never;

  it('takes the goal for a redeem that names no amount, and one for the rest', () => {
    const resolved = scanOf({ scan: { actions }, stamps }).actions;
    expect(resolved.map((a) => a.amount)).toEqual([1, 12, 1]);
  });

  it('keeps an amount the template names', () => {
    const named = [{ id: 'r', label: 'R', kind: 'take', input: 'stamps', amount: 5 }] as never;
    expect(scanOf({ scan: { actions: named }, stamps }).actions[0]?.amount).toBe(5);
  });
});
