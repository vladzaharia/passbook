import { describe, expect, it } from 'vitest';
import { applyFilter, dayIndex, graphemeLength, sanitize, sanitized, truncate } from './format.ts';
import { FORMAT } from './test-kit.ts';

const at = (iso: string) => Date.parse(iso);
const ctx = (zone: string, now: string) => ({ ...FORMAT, timeZone: zone, now: at(now) });

describe('filters', () => {
  it('formats dates and times in the actor zone, in two zones', () => {
    const ms = at('2026-11-03T23:02:00Z');
    expect(applyFilter('date', ms, ctx('America/New_York', '2026-11-05T12:00:00Z'))).toBe(
      'Nov 3, 2026',
    );
    expect(applyFilter('time', ms, ctx('America/New_York', '2026-11-05T12:00:00Z'))).toBe(
      '6:02 PM',
    );
    expect(applyFilter('time', ms, ctx('Asia/Tokyo', '2026-11-05T12:00:00Z'))).toBe('8:02 AM');
    expect(applyFilter('date', ms, ctx('Asia/Tokyo', '2026-11-05T12:00:00Z'))).toBe('Nov 4, 2026');
  });

  it('keeps a date-only value on its calendar day in every zone', () => {
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles'])
      expect(applyFilter('date', '2026-11-03', ctx(zone, '2026-11-05T12:00:00Z'))).toBe(
        'Nov 3, 2026',
      );
  });

  it('shows the year in datetime only when it is not this year', () => {
    const c = ctx('America/New_York', '2026-11-05T12:00:00Z');
    expect(applyFilter('datetime', at('2026-11-03T23:02:00Z'), c)).toBe('Nov 3, 6:02 PM');
    expect(applyFilter('datetime', at('2025-11-03T23:02:00Z'), c)).toBe('Nov 3, 2025, 6:02 PM');
  });

  it('counts calendar days across a DST change', () => {
    // US clocks went back on Nov 1, 2026: Oct 31 and Nov 2 are two calendar days apart.
    const c = ctx('America/New_York', '2026-11-02T17:00:00Z');
    expect(
      dayIndex(at('2026-11-02T17:00:00Z'), c.timeZone) -
        dayIndex(at('2026-10-31T12:00:00Z'), c.timeZone),
    ).toBe(2);
    expect(applyFilter('ago', at('2026-10-31T12:00:00Z'), c)).toBe('2 days ago');
  });

  it('day: today, yesterday, tomorrow, a weekday and a date, around midnight', () => {
    const c = ctx('America/New_York', '2026-11-05T04:30:00Z'); // Nov 4, 11:30 PM local
    expect(applyFilter('day', at('2026-11-05T04:50:00Z'), c)).toBe('Today');
    expect(applyFilter('day', at('2026-11-05T05:10:00Z'), c)).toBe('Tomorrow');
    expect(applyFilter('day', at('2026-11-04T03:00:00Z'), c)).toBe('Yesterday');
    expect(applyFilter('day', at('2026-11-07T17:00:00Z'), c)).toBe('Sat');
    expect(applyFilter('day', at('2026-12-25T17:00:00Z'), c)).toBe('Dec 25');
    expect(applyFilter('day', at('2027-01-02T17:00:00Z'), c)).toBe('Jan 2, 2027');
  });

  it('ago: just now, minutes, hours, days, then a date; the year boundary', () => {
    const c = ctx('America/New_York', '2026-11-05T18:00:00Z');
    expect(applyFilter('ago', at('2026-11-05T17:59:40Z'), c)).toBe('just now');
    expect(applyFilter('ago', at('2026-11-05T17:56:00Z'), c)).toBe('4 min ago');
    expect(applyFilter('ago', at('2026-11-05T16:00:00Z'), c)).toBe('2 h ago');
    expect(applyFilter('ago', at('2026-11-02T18:00:00Z'), c)).toBe('3 days ago');
    expect(applyFilter('ago', at('2026-10-20T18:00:00Z'), c)).toBe('Oct 20');
    const newYear = ctx('America/New_York', '2027-01-02T18:00:00Z');
    expect(applyFilter('ago', at('2026-12-20T18:00:00Z'), newYear)).toBe('Dec 20, 2026');
  });

  it('count, money, upper and duration', () => {
    expect(applyFilter('count', 1240, FORMAT)).toBe('1,240');
    expect(applyFilter('money', 42.5, { ...FORMAT, currency: 'USD' })).toBe('$42.50');
    expect(applyFilter('money', 42.5, FORMAT)).toBe('42.5');
    expect(applyFilter('upper', 'vip', FORMAT)).toBe('VIP');
    expect(applyFilter('duration', 92 * 60_000, FORMAT)).toBe('1 h 32 min');
    expect(applyFilter('duration', 40 * 60_000, FORMAT)).toBe('40 min');
    expect(applyFilter('duration', 45_000, FORMAT)).toBe('45 s');
  });

  it('gives "" for an empty or unusable value', () => {
    expect(applyFilter('date', 'soon', FORMAT)).toBe('');
    expect(applyFilter('count', 'x', FORMAT)).toBe('');
    expect(applyFilter('upper', undefined, FORMAT)).toBe('');
  });
});

describe('text hygiene', () => {
  it('truncates by grapheme, not code unit', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('👍👍👍👍', 5)).toBe('👍👍…'); // 4 graphemes, 8 UTF-16 units: the contract counts units
    expect(truncate('👨‍👩‍👧', 8)).toBe('👨‍👩‍👧'.length > 8 ? '…' : '👨‍👩‍👧');
    expect(truncate('e\u0301'.repeat(4), 5)).toBe('e\u0301e\u0301\u2026'); // marks never split
    expect(graphemeLength('é👍🏽')).toBe(2);
  });

  it('strips control and bidi characters, collapses whitespace, normalizes', () => {
    expect(sanitize('  a‮b \n\t c\u0007 ')).toBe('ab c');
    expect(sanitize('é')).toBe('é');
    expect(sanitize('a\n\n\nb  c', true)).toBe('a\nb c');
    expect(sanitized('x'.repeat(30), 24)).toHaveLength(24);
  });
});
