import { describe, expect, it } from 'vitest';
import type { VoidRule } from '../../../shared/contracts/connections.ts';
import type { UpstreamRecord } from '../../connectors/types.ts';
import { ValidationError } from '../../platform/errors.ts';
import { matchesVoidWhen, validateVoidWhen, voidWhenIssues } from './void-when.ts';

const present = (from: string): VoidRule => ({ from, op: 'present' });
const isOneOf = (from: string, ...values: (string | number | boolean)[]): VoidRule => ({
  from,
  op: 'in',
  values,
});

describe('voidWhenIssues', () => {
  it.each<[string, VoidRule[], string]>([
    ['bad pointer', [present('/a/~2')], 'voidWhen.0.from'],
    ['reserved name', [present('/__proto__')], 'voidWhen.0.from'],
    ['reserved nested', [present('/a/constructor')], 'voidWhen.0.from'],
    [
      'unknown op',
      [{ from: '/a', op: 'eq', values: ['x'] } as unknown as VoidRule],
      'voidWhen.0.op',
    ],
    ['in without values', [{ from: '/a', op: 'in' } as VoidRule], 'voidWhen.0.values'],
    ['in with empty values', [{ from: '/a', op: 'in', values: [] }], 'voidWhen.0.values'],
    ['21 values', [isOneOf('/a', ...Array.from({ length: 21 }, (_, i) => i))], 'voidWhen.0.values'],
    [
      'object value',
      [{ from: '/a', op: 'in', values: [{}] } as unknown as VoidRule],
      'voidWhen.0.values',
    ],
    [
      'null value',
      [{ from: '/a', op: 'in', values: [null] } as unknown as VoidRule],
      'voidWhen.0.values',
    ],
    ['present with values', [{ from: '/a', op: 'present', values: ['x'] }], 'voidWhen.0.values'],
    ['9 rules', Array.from({ length: 9 }, () => present('/a')), 'voidWhen'],
  ])('%s', (_n, rules, path) => {
    expect(voidWhenIssues(rules).map((i) => i.path)).toContain(path);
    expect(() => validateVoidWhen(rules)).toThrow(ValidationError);
  });

  it('accepts 8 rules and the shipped shapes', () => {
    expect(voidWhenIssues(Array.from({ length: 8 }, () => present('/a')))).toEqual([]);
    expect(
      voidWhenIssues([
        isOneOf('/status', 'canceled', 'x'),
        isOneOf('/refunded', true),
        present(''),
      ]),
    ).toEqual([]);
  });
});

describe('matchesVoidWhen', () => {
  it.each([
    ['a string', 'x', true],
    ['0', 0, true],
    ['false', false, true],
    ['null', null, false],
    ['empty string', '', false],
    ['missing', undefined, false],
  ])('present on %s -> %j', (_n, value, expected) => {
    const record: UpstreamRecord = value === undefined ? {} : { f: value };
    expect(matchesVoidWhen([present('/f')], record)).toBe(expected);
  });

  it('in is strict: exact case and exact type', () => {
    const rule = isOneOf('/status', 'canceled', 'incomplete_expired');
    expect(matchesVoidWhen([rule], { status: 'canceled' })).toBe(true);
    expect(matchesVoidWhen([rule], { status: 'Canceled' })).toBe(false);
    expect(matchesVoidWhen([isOneOf('/n', 1)], { n: '1' })).toBe(false);
    expect(matchesVoidWhen([isOneOf('/refunded', true)], { refunded: true })).toBe(true);
    expect(matchesVoidWhen([isOneOf('/refunded', true)], { refunded: false })).toBe(false);
    expect(matchesVoidWhen([rule], {})).toBe(false);
  });

  it('rules are OR-ed and an empty list never matches', () => {
    const rules = [present('/cancelledAt'), isOneOf('/financialStatus', 'refunded', 'voided')];
    expect(matchesVoidWhen(rules, { financialStatus: 'voided' })).toBe(true);
    expect(matchesVoidWhen(rules, { cancelledAt: '2026-01-01' })).toBe(true);
    expect(matchesVoidWhen(rules, { financialStatus: 'paid', cancelledAt: null })).toBe(false);
    expect(matchesVoidWhen([], { anything: 1 })).toBe(false);
  });
});
