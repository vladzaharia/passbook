import { describe, expect, it } from 'vitest';
import { localDay, statusLine, whenLine } from './visitors.ts';

describe('whenLine', () => {
  it('gives one date for a same-day visit and both when it crosses midnight', () => {
    const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
    expect(whenLine(at(25, 9), at(25, 17))).toBe('Nov 25, 9:00 AM – 5:00 PM');
    expect(whenLine(at(25, 22), at(26, 2))).toBe('Nov 25, 10:00 PM – Nov 26, 2:00 AM');
  });
});

describe('statusLine', () => {
  it('adds the time only to checked in and checked out', () => {
    const at = new Date(2026, 10, 25, 9, 12).getTime();
    expect(statusLine({ status: 'in', statusAt: at })).toBe('Checked in 9:12 AM');
    expect(statusLine({ status: 'out', statusAt: at })).toBe('Checked out 9:12 AM');
    expect(statusLine({ status: 'expected', statusAt: null })).toBe('Expected');
    expect(statusLine({ status: 'no_show', statusAt: null })).toBe('No-show');
  });
});

describe('localDay', () => {
  it('spans local midnight to midnight', () => {
    const { start, end } = localDay(new Date(2026, 10, 25, 15, 30));
    expect(new Date(start)).toEqual(new Date(2026, 10, 25));
    expect(new Date(end)).toEqual(new Date(2026, 10, 26));
  });
});
