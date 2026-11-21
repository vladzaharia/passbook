import { describe, expect, it } from 'vitest';
import { applyMapping, mappingIssues, transform } from './transform.ts';

const date = (value: string, input: string, output = 'date') =>
  transform(value, { from: '', transform: { kind: 'date', options: { input, output } } });

describe('date formats', () => {
  it.each([
    ['31/12/2026', 'dmy', '2026-12-31'],
    ['1.2.2026', 'dmy', '2026-02-01'],
    ['12/31/2026', 'mdy', '2026-12-31'],
    ['2026-12-31', 'ymd', '2026-12-31'],
    ['2026/1/5', 'ymd', '2026-01-05'],
  ])('reads %s as %s', (value, input, out) => {
    expect(date(value, input)).toBe(out);
  });

  it('keeps a time of day', () => {
    expect(date('31/12/2026 13:45', 'dmy', 'iso')).toBe('2026-12-31T13:45:00.000Z');
  });

  it.each([
    ['31/02/2026', 'dmy'],
    ['13/01/2026', 'mdy'],
    ['31/12/26', 'dmy'],
    ['x', 'ymd'],
  ])('refuses %s as %s', (value, input) => {
    expect(date(value, input)).toBeUndefined();
  });

  it('does not read a number as a day-first, month-first or year-first date', () => {
    for (const input of ['dmy', 'mdy', 'ymd']) {
      expect(
        transform(20261231, { from: '', transform: { kind: 'date', options: { input } } }),
      ).toBeUndefined();
    }
    expect(transform(1_700_000_000, { from: '', transform: { kind: 'date' } })).toBeDefined();
  });

  it('accepts the new inputs in a mapping check', () => {
    const entry = (input: string) => ({
      d: { from: '/d', transform: { kind: 'date', options: { input } } },
    });
    expect(mappingIssues(entry('dmy'))).toEqual([]);
    expect(mappingIssues(entry('xyz'))).toHaveLength(1);
  });

  it('applies through a mapping', () => {
    const mapping = {
      d: { from: 'Joined', transform: { kind: 'date', options: { input: 'dmy' } } },
    };
    expect(applyMapping(mapping, { Joined: '05/03/2024' })).toEqual({
      d: '2024-03-05T00:00:00.000Z',
    });
  });
});

describe('join', () => {
  const entry = {
    from: '/First',
    transform: { kind: 'join', options: { with: ['/Last'] } },
  };

  it('joins columns with a space and skips blanks', () => {
    expect(applyMapping({ name: entry }, { First: 'Kai', Last: 'Osei' })).toEqual({
      name: 'Kai Osei',
    });
    expect(applyMapping({ name: entry }, { Last: 'Osei' })).toEqual({ name: 'Osei' });
    expect(applyMapping({ name: entry }, { First: ' ' })).toEqual({});
  });

  it('takes a separator', () => {
    const e = {
      ...entry,
      transform: { kind: 'join', options: { with: ['/Last'], separator: ', ' } },
    };
    expect(applyMapping({ name: e }, { First: 'Kai', Last: 'Osei' })).toEqual({
      name: 'Kai, Osei',
    });
  });

  it('is checked', () => {
    expect(mappingIssues({ name: entry })).toEqual([]);
    const bad = { from: '/a', transform: { kind: 'join', options: { with: [] } } };
    expect(mappingIssues({ name: bad })).toHaveLength(1);
  });
});

describe('enum', () => {
  const e = (options: Record<string, never> | object) => ({
    from: '',
    transform: { kind: 'enum', options: options as Record<string, never> },
  });

  it('keeps the exact map first and falls back to the map ignoring case', () => {
    expect(transform('Gold', e({ map: { Gold: 'pro', gold: 'x' } }))).toBe('pro');
    expect(transform('GOLD', e({ map: { gold: 'pro' } }))).toBe('pro');
  });

  it('matches option keys and labels ignoring case', () => {
    const labels = { member: 'Monthly', annual: 'Annual' };
    expect(transform('monthly', e({ labels }))).toBe('member');
    expect(transform('MEMBER', e({ labels }))).toBe('member');
    expect(transform('Gold', e({ labels }))).toBeUndefined();
    expect(transform('Gold', e({ labels, default: 'member' }))).toBe('member');
  });

  it('needs a map or labels', () => {
    expect(mappingIssues({ a: e({ labels: {} }) })).toEqual([]);
    expect(mappingIssues({ a: e({}) })).toHaveLength(1);
  });
});
