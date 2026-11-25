import { describe, expect, it } from 'vitest';
import { nextBoundary, passBoundaries } from '../../boundaries.ts';
import { normalizePass } from '../../schema/normalize.ts';
import type { Json, PassJson } from '../../types.ts';
import { type UpcomingEventsConfig, upcomingEvents } from './index.ts';
import { retimePass, sameTimedKeys, timedKeysOf, withTimedKeys } from './timed.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2030-06-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const identity = { passTypeIdentifier: 'p', teamIdentifier: 'TEAM123456' };
const at = (h: number, end = 2) => ({
  startsAt: iso(T0 + h * HOUR),
  endsAt: iso(T0 + (h + end) * HOUR),
});

/** The pass as relevance-window leaves it before upcoming-events: the ticket's own window and date. */
const base = (): PassJson =>
  ({
    eventTicket: {},
    relevantDates: [{ startDate: iso(T0 - 24 * HOUR), endDate: iso(T0 - 22 * HOUR) }],
    relevantDate: iso(T0 - 24 * HOUR),
  }) as PassJson;

/** What a publish at `now` would build. */
const build = (events: Json, config: UpcomingEventsConfig, now: number, pass = base()) => {
  upcomingEvents.apply(pass, { events }, config, { now: new Date(now), identity, lookups: {} });
  return normalizePass(pass);
};

const season = Array.from({ length: 14 }, (_, i) => ({ name: `Game ${i + 1}`, ...at(i * 6) }));
const scheduled: UpcomingEventsConfig = { input: 'events', schedule: { leadMinutes: 60 } };

describe('retimePass', () => {
  it('changes nothing in the phase the pass was built in', () => {
    const built = build(season, scheduled, T0 - HOUR);
    const again = retimePass(built, { events: season }, scheduled, {}, T0 - 30 * 60_000);
    expect(sameTimedKeys(timedKeysOf(again), timedKeysOf(built))).toBe(true);
    expect(again).toEqual(built);
  });

  it('gives what a publish would, at and between every boundary of the season', () => {
    const built = build(season, scheduled, T0 - HOUR);
    let shown = built;
    let t = T0 - HOUR;
    let crossed = 0;
    for (let next = nextBoundary(passBoundaries(shown), t); next !== null; crossed++) {
      for (const when of [next, next + HOUR / 2]) {
        const retimed = retimePass(built, { events: season }, scheduled, {}, when);
        const fresh = build(season, scheduled, when);
        if (!fresh.upcomingPassInformation) break;
        expect(timedKeysOf(retimed), `boundary ${crossed}`).toEqual(timedKeysOf(fresh));
      }
      t = next;
      shown = retimePass(built, { events: season }, scheduled, {}, t);
      next = nextBoundary(passBoundaries(shown), t);
    }
    // Every game started and ended, past the cap of 10; the expiry stays after the last one.
    expect(crossed).toBe(2 * season.length);
    expect(shown.upcomingPassInformation).toBeUndefined();
    expect(Date.parse(shown.expirationDate ?? '')).toBe(T0 + 80 * HOUR);
    expect(shown.relevantDates).toEqual(base().relevantDates);
  });

  it('moves the next event up past the cap and keeps the pass own window', () => {
    const built = build(season, scheduled, T0 - HOUR);
    expect(built.upcomingPassInformation?.map((e) => e.name).at(-1)).toBe('Game 10');
    const later = retimePass(built, { events: season }, scheduled, {}, T0 + 2 * HOUR + 1);
    expect(later.upcomingPassInformation?.map((e) => e.name)).toEqual(
      season.slice(1, 11).map((g) => g.name),
    );
    expect(later.relevantDates?.[0]).toEqual(base().relevantDates?.[0]);
    expect(later.relevantDate).toBe(base().relevantDate);
    // The expiry follows the last listed game.
    expect(Date.parse(later.expirationDate ?? '')).toBe(T0 + 62 * HOUR);
  });

  it('marks the running event and leaves every other key as built', () => {
    const config: UpcomingEventsConfig = { input: 'events' };
    const built = {
      ...build(season.slice(0, 2), config, T0 - HOUR),
      serialNumber: 'S1',
      expirationDate: '2031-01-01T00:00:00Z',
    } as PassJson;
    const running = retimePass(built, { events: season.slice(0, 2) }, config, {}, T0 + HOUR);
    expect(running.upcomingPassInformation?.map((e) => e.isActive)).toEqual([true, false]);
    expect(running.serialNumber).toBe('S1');
    expect(running.expirationDate).toBe('2031-01-01T00:00:00Z');
    expect(running.relevantDates).toEqual(built.relevantDates);
  });

  it('drops the list when the input holds none', () => {
    const built = build(season.slice(0, 1), { input: 'events' }, T0 - HOUR);
    const cleared = retimePass(built, {}, { input: 'events' }, {}, T0);
    expect(cleared.upcomingPassInformation).toBeUndefined();
  });
});

describe('timed keys', () => {
  it('splices the keys in and drops the ones a render lacks', () => {
    const pass = { serialNumber: 'S', relevantDate: '2030-01-01T00:00:00Z' } as PassJson;
    const out = withTimedKeys(pass, { expirationDate: '2031-01-01T00:00:00Z' });
    expect(out).toEqual({ serialNumber: 'S', expirationDate: '2031-01-01T00:00:00Z' });
    expect(timedKeysOf(out)).toEqual({ expirationDate: '2031-01-01T00:00:00Z' });
  });

  it('compares regardless of key order', () => {
    const a = { relevantDates: [{ startDate: 'x', endDate: 'y' }] } as PassJson;
    const b = { relevantDates: [{ endDate: 'y', startDate: 'x' }] } as PassJson;
    expect(sameTimedKeys(timedKeysOf(a), timedKeysOf(b))).toBe(true);
    expect(sameTimedKeys(timedKeysOf(a), {})).toBe(false);
  });
});
