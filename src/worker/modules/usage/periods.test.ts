import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  followingPeriod,
  periodAt,
  periodHours,
  periodOf,
  validZone,
} from './periods.ts';

const LA = 'America/Los_Angeles';

describe('periods', () => {
  it('counts 743 hours in a spring month and 745 in an autumn month of 31 days', () => {
    expect(periodHours(periodOf('2026-03', LA))).toBe(743);
    expect(periodHours(periodOf('2026-03', 'Europe/Berlin'))).toBe(743);
    expect(periodHours(periodOf('2026-10', 'Europe/Berlin'))).toBe(745);
    expect(periodHours(periodOf('2026-11', LA))).toBe(721);
    expect(periodHours(periodOf('2026-07', LA))).toBe(744);
  });

  it('knows which zones the runtime can use', () => {
    expect(validZone('Europe/Berlin')).toBe(true);
    expect(validZone('Mars/Olympus')).toBe(false);
  });

  it('starts a period at local midnight, not at UTC midnight', () => {
    const p = periodOf('2026-11', LA);
    expect(new Date(p.startMs).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(p.endMs).toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });

  it('puts an instant just after local midnight in the new month', () => {
    const edge = Date.UTC(2026, 11, 1, 8, 0, 0);
    expect(periodAt(edge - 1, LA).month).toBe('2026-11');
    expect(periodAt(edge, LA).month).toBe('2026-12');
  });

  it('has 23 and 25 hour days on the changeover days', () => {
    const march = periodOf('2026-03', LA);
    const days = daysBetween(march, LA, march.startMs, march.endMs);
    expect(days).toHaveLength(31);
    const hours = (d: { startMs: number; endMs: number }) => (d.endMs - d.startMs) / 3_600_000;
    expect(hours(days[7] as (typeof days)[0])).toBe(23);
    expect(days[7]?.localDay).toBe('2026-03-08');
    const nov = periodOf('2026-11', LA);
    const nd = daysBetween(nov, LA, nov.startMs, nov.endMs);
    expect(hours(nd[0] as (typeof nd)[0])).toBe(25);
    expect(nd.reduce((n, d) => n + hours(d), 0)).toBe(721);
  });

  it('follows the previous period without a gap and applies a new zone from there', () => {
    const la = periodOf('2026-06', LA);
    const next = followingPeriod(la, 'Europe/Berlin');
    expect(next.month).toBe('2026-07');
    expect(next.startMs).toBe(la.endMs);
    expect(next.endMs).toBe(periodOf('2026-08', 'Europe/Berlin').startMs);
    const days = daysBetween(next, 'Europe/Berlin', next.startMs, next.endMs);
    expect(days[0]?.startMs).toBe(la.endMs);
    expect(days[1]?.startMs).toBe(Date.UTC(2026, 6, 1, 22, 0, 0));
    expect(days[days.length - 1]?.endMs).toBe(next.endMs);
  });

  it('only returns the days in the window', () => {
    const p = periodOf('2026-11', LA);
    const days = daysBetween(p, LA, p.startMs + 3_600_000, p.startMs + 26 * 3_600_000);
    expect(days.map((d) => d.localDay)).toEqual(['2026-11-01', '2026-11-02']);
  });
});
