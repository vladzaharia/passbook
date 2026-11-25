import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  formatAgo,
  formatCount,
  formatDateTime,
  formatDay,
  formatEndedOn,
  formatExpiry,
  formatMaybeDate,
  formatRelative,
  formatShortDate,
  formatShortDateHour,
  formatTime,
  formatWallTime,
  pluralize,
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
    expect(formatAgo(0, 10_000)).toBe('just now');
    expect(formatAgo(10_000, 0)).toBe('just now');
    expect(formatAgo(0, 120_000)).toBe('2 minutes ago');
    expect(daysUntil(3 * 86_400_000 + 5, 0)).toBe(3);
  });
});

describe('formatEndedOn', () => {
  // 2026-11-19 01:50 UTC is still Nov 18 in New York: one pass, one date per holder zone.
  const at = Date.UTC(2026, 10, 19, 1, 50);
  const pass = { modifiedAt: at, voidedAt: at };

  it('is the day in the holder zone, Seattle when none is given', () => {
    expect(formatEndedOn('voided', pass, 'America/New_York')).toBe('Nov 18, 2026');
    expect(formatEndedOn('voided', pass, 'UTC')).toBe('Nov 19, 2026');
    expect(formatEndedOn('voided', pass)).toBe('Nov 18, 2026');
  });

  it('falls back to the last change, and an expired pass names its expiry', () => {
    expect(formatEndedOn('voided', { modifiedAt: at, voidedAt: null }, 'UTC')).toBe('Nov 19, 2026');
    expect(formatEndedOn('expired', { ...pass, expirationDate: '2026-10-01T12:00:00Z' })).toBe(
      'Oct 1, 2026',
    );
    expect(formatEndedOn('voided', { modifiedAt: Number.NaN })).toBeNull();
  });
});

describe('formatExpiry and formatMaybeDate in the org zone', () => {
  it('reads a Z time in Seattle time unless a zone is given', () => {
    expect(formatExpiry('2026-12-01T03:00:00Z')).toBe('Nov 30, 2026, 7:00 PM PST');
    expect(formatExpiry('2026-12-01T03:00:00Z', 'Asia/Tokyo')).toBe('Dec 1, 2026, 12:00 PM');
    expect(formatMaybeDate('2026-12-01T03:00:00Z')).toBe('Nov 30, 2026');
    expect(formatMaybeDate('2026-12-01T03:00:00Z', 'Asia/Tokyo')).toBe('Dec 1, 2026');
    expect(formatMaybeDate('2026-12-01', 'Asia/Tokyo')).toBe('Dec 1, 2026');
    // Midnight UTC is a stored calendar date: the same day in every zone.
    expect(formatMaybeDate('2026-12-01T00:00:00Z')).toBe('Dec 1, 2026');
    expect(formatExpiry('2026-12-01T00:00:00.000Z')).toBe('Dec 1, 2026');
  });
});

describe('formatExpiry date-only', () => {
  it('shows the written day in a western zone', () => {
    expect(formatExpiry('2026-12-01', 'America/Los_Angeles')).toBe('Dec 1, 2026');
  });
});

describe('pluralize', () => {
  it('keeps the noun singular only for 1', () => {
    expect(pluralize(0, 'tag')).toBe('0 tags');
    expect(pluralize(1, 'tag')).toBe('1 tag');
    expect(pluralize(2, 'tag')).toBe('2 tags');
  });
});
