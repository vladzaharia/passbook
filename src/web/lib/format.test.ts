import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  formatCount,
  formatDateTime,
  formatDay,
  formatRelative,
  formatShortDate,
  formatShortDateHour,
  formatTime,
  formatWallTime,
} from './format.ts';

// Local wall time, so the expectations hold in any zone the tests run in.
const at = new Date(2026, 10, 2, 23, 51).getTime();

describe('format', () => {
  it('joins date and time the same way in every engine', () => {
    expect(formatDateTime(at)).toBe('Nov 2, 2026, 11:51 PM');
    expect(formatDateTime(null)).toBe('Never');
    expect(formatDateTime(0, '—')).toBe('—');
  });

  it('writes days, short dates and times in one locale', () => {
    expect(formatDay(at)).toBe('Nov 2, 2026');
    expect(formatDay(undefined)).toBe('None');
    expect(formatShortDate(at)).toBe('Nov 2');
    expect(formatTime(at)).toBe('11:51 PM');
    expect(formatShortDateHour(at)).toBe('Nov 2, 11 PM');
  });

  it('spells out a wall time without shifting its zone', () => {
    expect(formatWallTime('2026-11-15T04:08')).toBe('Nov 15, 2026, 4:08 AM');
    expect(formatWallTime('nope')).toBe('');
  });

  it('counts and relates in en-US', () => {
    expect(formatCount(12345)).toBe('12,345');
    expect(formatRelative(0, 2 * 86_400_000)).toBe('2 days ago');
    expect(formatRelative(3_600_000, 0)).toBe('in 1 hour');
    expect(formatRelative(0, 10_000)).toBe('this minute');
    expect(daysUntil(3 * 86_400_000 + 5, 0)).toBe(3);
  });
});
