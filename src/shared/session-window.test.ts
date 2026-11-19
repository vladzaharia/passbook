import { describe, expect, it } from 'vitest';
import { clockIn, nextEdge, whenIn, windowLabel } from './session-window.ts';

const at = (iso: string) => Date.parse(iso);
const ZONE = 'America/New_York';

describe('session window labels', () => {
  const now = at('2026-11-17T15:00:00Z'); // Tue 10:00 in New York
  it('reads clock times in the session zone', () => {
    expect(clockIn(at('2026-11-17T03:00:00Z'), ZONE)).toBe('10:00 PM');
    expect(clockIn(at('2026-11-17T05:00:00Z'), 'Europe/London')).toBe('5:00 AM');
  });
  it('adds the weekday only after today, the date after a week', () => {
    expect(whenIn(at('2026-11-18T03:00:00Z'), ZONE, now, ZONE)).toBe('10:00 PM');
    expect(whenIn(at('2026-11-18T13:00:00Z'), ZONE, now, ZONE)).toBe('Wed 8:00 AM');
    expect(whenIn(at('2026-11-24T13:00:00Z'), ZONE, now, ZONE)).toBe('Nov 24, 8:00 AM');
  });
  it('names the zone only when it is not the viewer’s', () => {
    expect(whenIn(at('2026-11-18T13:00:00Z'), ZONE, now, 'Europe/London')).toBe('Wed 8:00 AM EST');
  });
  it('labels open, closed and held states', () => {
    const open = {
      open: true,
      by: 'hours',
      opensAt: null,
      closesAt: at('2026-11-18T03:00:00Z'),
    } as const;
    expect(windowLabel(open, ZONE, now, ZONE)).toBe('Open until 10:00 PM');
    expect(windowLabel({ ...open, by: 'hold' }, ZONE, now, ZONE)).toBe('Held open until 10:00 PM');
    expect(windowLabel({ ...open, by: 'always', closesAt: null }, ZONE, now, ZONE)).toBeNull();
    const closed = {
      open: false,
      by: 'hours',
      opensAt: at('2026-11-18T13:00:00Z'),
      closesAt: null,
    } as const;
    expect(windowLabel(closed, ZONE, now, ZONE)).toBe('Opens Wed 8:00 AM');
    expect(windowLabel({ ...closed, by: 'hold' }, ZONE, now, ZONE)).toBe(
      'Closed until Wed 8:00 AM',
    );
    expect(windowLabel({ ...closed, opensAt: null }, ZONE, now, ZONE)).toBe('No opening set');
    expect(windowLabel({ ...closed, by: 'hold', opensAt: null }, ZONE, now, ZONE)).toBe(
      'Closed by hand',
    );
  });
  it('flips at the boundary instant', () => {
    const closesAt = at('2026-11-18T03:00:00Z');
    const w = (open: boolean) => ({
      open,
      by: 'hours' as const,
      opensAt: open ? null : closesAt,
      closesAt: open ? closesAt : null,
    });
    expect(windowLabel(w(true), ZONE, closesAt - 1, ZONE)).toBe('Open until 10:00 PM');
    expect(windowLabel(w(false), ZONE, closesAt, ZONE)).toBe('Opens 10:00 PM');
    expect(nextEdge(w(true))).toBe(closesAt);
    expect(nextEdge(w(false))).toBe(closesAt);
  });
  it('keeps the wall clock across a DST change', () => {
    // US spring forward 2027-03-14: 08:00 is 12:00Z after, 13:00Z before.
    expect(clockIn(at('2027-03-13T13:00:00Z'), ZONE)).toBe('8:00 AM');
    expect(clockIn(at('2027-03-14T12:00:00Z'), ZONE)).toBe('8:00 AM');
  });
});
