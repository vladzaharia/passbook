import { describe, expect, it } from 'vitest';
import {
  type SessionHold,
  type SessionHours,
  SessionHoursSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { assertSessionOpen, nextEdgeAt, pruneDates, sessionWindow } from './session-hours.ts';

const at = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const row = (hours: SessionHours, time_zone = 'UTC', hold: SessionHold | null = null) => ({
  time_zone,
  hours: JSON.stringify(hours),
  hold: hold ? JSON.stringify(hold) : null,
});
// 2026-11-18 is a Wednesday.
const WED: SessionHours = { wed: ['08:00-22:00'], dates: { '2026-11-18': [] } };

describe('dated exceptions', () => {
  it('a closed date is closed all day and opens at the next weekly window', () => {
    const w = sessionWindow(row(WED), at(2026, 11, 18, 9));
    expect(w).toEqual({ open: false, by: 'hours', opensAt: at(2026, 11, 25, 8), closesAt: null });
    expect(() => assertSessionOpen(row(WED), at(2026, 11, 18, 9))).toThrowError(
      expect.objectContaining({ code: 'SCANNING_SESSION_CLOSED' }),
    );
  });

  it('special hours replace that date, and the other weeks keep the weekly spans', () => {
    const r = row({ wed: ['08:00-22:00'], dates: { '2026-11-18': ['10:00-14:00'] } });
    expect(sessionWindow(r, at(2026, 11, 18, 9)).opensAt).toBe(at(2026, 11, 18, 10));
    expect(sessionWindow(r, at(2026, 11, 18, 11))).toMatchObject({
      open: true,
      closesAt: at(2026, 11, 18, 14),
    });
    expect(sessionWindow(r, at(2026, 11, 18, 15)).open).toBe(false);
    expect(sessionWindow(r, at(2026, 11, 25, 15)).open).toBe(true);
  });

  it('special hours open a day the week has none', () => {
    const r = row({ wed: ['08:00-22:00'], dates: { '2026-11-19': ['12:00-13:00'] } });
    expect(sessionWindow(r, at(2026, 11, 19, 12, 30)).open).toBe(true);
    expect(sessionWindow(r, at(2026, 11, 19, 14)).open).toBe(false);
  });

  it('a date counts in the session zone, not UTC', () => {
    // 2026-11-18 in Tokyo runs from 2026-11-17 15:00 UTC.
    const r = row({ wed: ['08:00-22:00'], dates: { '2026-11-18': [] } }, 'Asia/Tokyo');
    expect(sessionWindow(r, at(2026, 11, 18, 0)).open).toBe(false);
    expect(sessionWindow(r, at(2026, 11, 18, 0)).opensAt).toBe(at(2026, 11, 24, 23));
    // The same instant in UTC is open on Wednesday 09:00 without a Tokyo exception.
    expect(sessionWindow(row({ wed: ['08:00-22:00'] }), at(2026, 11, 18, 9)).open).toBe(true);
  });

  it('an overnight span from a closed date does not spill into the next day', () => {
    const r = row({ fri: ['18:00-02:00'], dates: { '2026-11-20': [] } });
    expect(sessionWindow(r, at(2026, 11, 20, 23)).open).toBe(false);
    expect(sessionWindow(r, at(2026, 11, 21, 1)).open).toBe(false);
  });

  it('follows DST on a special date (London spring-forward)', () => {
    const r = row(
      { dates: { '2026-03-29': ['00:30-04:00'] }, mon: ['09:00-10:00'] },
      'Europe/London',
    );
    expect(sessionWindow(r, at(2026, 3, 29, 2, 59)).open).toBe(true);
    expect(sessionWindow(r, at(2026, 3, 29, 3)).open).toBe(false);
  });

  it('Open now on a closed date holds open until its end, then the date closes again', () => {
    const until = at(2026, 11, 18, 12);
    const r = row(WED, 'UTC', { state: 'open', until });
    expect(sessionWindow(r, at(2026, 11, 18, 9))).toMatchObject({ open: true, by: 'hold' });
    expect(sessionWindow(r, until).open).toBe(false);
  });

  it('bookmarks the edge a special date adds', () => {
    const r = row({ wed: ['08:00-22:00'], dates: { '2026-11-18': ['10:00-14:00'] } });
    expect(nextEdgeAt(r, at(2026, 11, 18, 9))).toBe(at(2026, 11, 18, 10));
  });

  it('prunes dates before yesterday in the session zone and keeps yesterday', () => {
    const hours = {
      wed: ['08:00-22:00'],
      dates: { '2026-11-16': [], '2026-11-17': ['18:00-02:00'], '2026-11-18': [] },
    };
    expect(pruneDates(hours, 'UTC', at(2026, 11, 18, 9)).dates).toEqual({
      '2026-11-17': ['18:00-02:00'],
      '2026-11-18': [],
    });
    // Auckland is already on the 19th, so only the 18th and later stay.
    expect(pruneDates(hours, 'Pacific/Auckland', at(2026, 11, 18, 12)).dates).toEqual({
      '2026-11-18': [],
    });
  });

  it('an overnight span on yesterday still covers the start of today', () => {
    const r = row({ wed: ['08:00-22:00'], dates: { '2026-11-17': ['18:00-02:00'] } });
    expect(sessionWindow(r, at(2026, 11, 18, 1)).open).toBe(true);
    expect(sessionWindow(r, at(2026, 11, 18, 2)).open).toBe(false);
  });
});

describe('dated exceptions contract', () => {
  const ok = (v: unknown) => SessionHoursSchema.safeParse(v).success;
  it('accepts closed and special dates and rejects bad ones', () => {
    expect(ok(WED)).toBe(true);
    expect(ok({ wed: ['08:00-22:00'], dates: { '2026-12-25': ['10:00-12:00'] } })).toBe(true);
    expect(ok({ wed: ['08:00-22:00'], dates: { '2026-02-30': [] } })).toBe(false);
    expect(ok({ wed: ['08:00-22:00'], dates: { tomorrow: [] } })).toBe(false);
    expect(ok({ wed: ['08:00-22:00'], dates: { '2026-12-25': ['10:00-10:00'] } })).toBe(false);
    expect(ok({ dates: { '2026-12-25': [] } })).toBe(false);
    expect(ok({ wed: ['08:00-22:00'], extra: [] })).toBe(false);
  });
});
