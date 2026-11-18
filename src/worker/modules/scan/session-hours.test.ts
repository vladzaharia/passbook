import { describe, expect, it } from 'vitest';
import type { SessionHold, SessionHours } from '../../../shared/contracts/scanning-sessions.ts';
import {
  activeHold,
  assertSessionOpen,
  defaultOpenUntil,
  nextEdgeAt,
  nextScheduledOpen,
  sessionWindow,
} from './session-hours.ts';

const HOUR = 3_600_000;
const at = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const row = (hours: SessionHours | null, time_zone = 'UTC', hold: SessionHold | null = null) => ({
  time_zone,
  hours: hours ? JSON.stringify(hours) : null,
  hold: hold ? JSON.stringify(hold) : null,
});
// 2026-11-18 is a Wednesday.
const WED: SessionHours = { wed: ['08:00-22:00'] };

describe('session window', () => {
  it('is always open without hours', () => {
    expect(sessionWindow(row(null), at(2026, 11, 18, 3))).toEqual({
      open: true,
      by: 'always',
      opensAt: null,
      closesAt: null,
    });
  });

  it('is open inside a span and closed outside it, with the instants', () => {
    const r = row(WED);
    expect(sessionWindow(r, at(2026, 11, 18, 9))).toEqual({
      open: true,
      by: 'hours',
      opensAt: null,
      closesAt: at(2026, 11, 18, 22),
    });
    expect(sessionWindow(r, at(2026, 11, 18, 7, 59)).open).toBe(false);
    expect(sessionWindow(r, at(2026, 11, 18, 7, 59)).opensAt).toBe(at(2026, 11, 18, 8));
    expect(sessionWindow(r, at(2026, 11, 18, 22)).open).toBe(false);
    expect(sessionWindow(r, at(2026, 11, 18, 22)).opensAt).toBe(at(2026, 11, 25, 8));
  });

  it('runs an overnight span past midnight', () => {
    const r = row({ fri: ['18:00-02:00'] });
    expect(sessionWindow(r, at(2026, 11, 20, 23)).open).toBe(true);
    const late = sessionWindow(r, at(2026, 11, 21, 1, 30));
    expect(late).toMatchObject({ open: true, closesAt: at(2026, 11, 21, 2) });
    expect(sessionWindow(r, at(2026, 11, 21, 2)).open).toBe(false);
  });

  it('closes when the stored schedule no longer parses', () => {
    // Hours that parse but cannot be reached: a stored span that no longer validates.
    const bad = { time_zone: 'UTC', hours: '{"wed":["nonsense"]}', hold: null };
    expect(sessionWindow(bad, at(2026, 11, 18, 9))).toEqual({
      open: false,
      by: 'hours',
      opensAt: null,
      closesAt: null,
    });
  });

  it('follows the wall clock over spring-forward in London', () => {
    // 2026-03-29: 01:00 UTC is 02:00 BST. Span 00:30-04:00 local is 2.5 h long in UTC terms.
    const r = row({ sun: ['00:30-04:00'] }, 'Europe/London');
    expect(sessionWindow(r, at(2026, 3, 29, 0, 45)).open).toBe(true);
    expect(sessionWindow(r, at(2026, 3, 29, 2, 59)).open).toBe(true);
    expect(sessionWindow(r, at(2026, 3, 29, 3, 0)).open).toBe(false);
    expect(sessionWindow(r, at(2026, 3, 29, 0, 45)).closesAt).toBe(at(2026, 3, 29, 3));
  });

  it('opens a start inside the New York spring gap at the first valid instant', () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00 UTC). 02:30 does not exist.
    const r = row({ sun: ['02:30-04:00'] }, 'America/New_York');
    expect(sessionWindow(r, at(2026, 3, 8, 6, 59)).open).toBe(false);
    expect(sessionWindow(r, at(2026, 3, 8, 6, 59)).opensAt).toBe(at(2026, 3, 8, 7));
    expect(sessionWindow(r, at(2026, 3, 8, 7)).open).toBe(true);
  });

  it('closes an end inside the London fall-back hour at its earlier reading', () => {
    // 2026-10-25: 02:00 BST falls back to 01:00 GMT (01:00 UTC). 01:30 happens twice.
    const r = row({ sun: ['00:30-01:30'] }, 'Europe/London');
    const open = sessionWindow(r, at(2026, 10, 24, 23, 45));
    expect(open.open).toBe(true);
    expect(open.closesAt).toBe(at(2026, 10, 25, 0, 30));
  });

  it('closes an end inside the New York fall-back hour at its earlier reading', () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST (06:00 UTC).
    const r = row({ sun: ['00:00-01:30'] }, 'America/New_York');
    const open = sessionWindow(r, at(2026, 11, 1, 4, 30));
    expect(open.open).toBe(true);
    expect(open.closesAt).toBe(at(2026, 11, 1, 5, 30));
  });
});

describe('hold', () => {
  const now = at(2026, 11, 18, 9);

  it('an open hold opens a closed session until its end', () => {
    const r = row(WED, 'UTC', { state: 'open', until: now + 2 * HOUR });
    const early = at(2026, 11, 18, 6);
    const w = sessionWindow(
      { ...r, hold: JSON.stringify({ state: 'open', until: early + 2 * HOUR }) },
      early,
    );
    expect(w).toEqual({ open: true, by: 'hold', opensAt: null, closesAt: early + 2 * HOUR });
    // After its end the hours decide again.
    expect(sessionWindow(r, now + 2 * HOUR + 1)).toMatchObject({ open: true, by: 'hours' });
    expect(sessionWindow(r, at(2026, 11, 18, 23))).toMatchObject({ open: false, by: 'hours' });
  });

  it('a closed hold closes an open session until its end, then hours resume', () => {
    const until = at(2026, 11, 25, 8);
    const r = row(WED, 'UTC', { state: 'closed', until });
    expect(sessionWindow(r, now)).toEqual({
      open: false,
      by: 'hold',
      opensAt: until,
      closesAt: null,
    });
    expect(sessionWindow(r, until)).toMatchObject({ open: true, by: 'hours' });
  });

  it('treats an ended hold as none', () => {
    expect(activeHold(JSON.stringify({ state: 'closed', until: now }), now)).toBeNull();
    expect(activeHold(JSON.stringify({ state: 'closed', until: now + 1 }), now)).not.toBeNull();
    expect(activeHold('not json', now)).toBeNull();
  });

  it('assertSessionOpen refuses with the closed code', () => {
    expect(() => assertSessionOpen(row(WED), at(2026, 11, 18, 3))).toThrowError(
      expect.objectContaining({ code: 'SCANNING_SESSION_CLOSED', status: 403 }),
    );
    expect(() => assertSessionOpen(row(WED), now)).not.toThrow();
  });
});

describe('planning helpers', () => {
  it('finds the next scheduled opening from an open or a closed moment', () => {
    const r = row(WED);
    expect(nextScheduledOpen(r, at(2026, 11, 18, 9))).toBe(at(2026, 11, 25, 8));
    expect(nextScheduledOpen(r, at(2026, 11, 18, 23))).toBe(at(2026, 11, 25, 8));
    expect(nextScheduledOpen(row(null), at(2026, 11, 18, 9))).toBeNull();
  });

  it('defaults Open now to the coming window within 6 h, else two hours', () => {
    const r = row(WED);
    expect(defaultOpenUntil(r, at(2026, 11, 18, 5))).toBe(at(2026, 11, 18, 22));
    expect(defaultOpenUntil(r, at(2026, 11, 18, 23))).toBe(at(2026, 11, 19, 1));
    expect(defaultOpenUntil(row(null), at(2026, 11, 18, 23))).toBe(at(2026, 11, 19, 1));
  });

  it('bookmarks the earlier of the hold end and the next hours edge', () => {
    const now = at(2026, 11, 18, 9);
    expect(nextEdgeAt(row(WED), now)).toBe(at(2026, 11, 18, 22));
    expect(nextEdgeAt(row(null), now)).toBeNull();
    const hold = { state: 'closed', until: now + HOUR } as const;
    expect(nextEdgeAt(row(WED, 'UTC', hold), now)).toBe(now + HOUR);
    expect(nextEdgeAt(row(null, 'UTC', hold), now)).toBe(now + HOUR);
  });
});
