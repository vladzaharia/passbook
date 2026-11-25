import { describe, expect, it } from 'vitest';
import {
  boundaryPhase,
  DEFAULT_EVENT_MINUTES,
  nextBoundary,
  passBoundaries,
} from './boundaries.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => Date.parse(iso);
const event = (date: string, end?: string) => ({
  dateInformation: { date },
  ...(end ? { semantics: { eventEndDate: end } } : {}),
});

describe('passBoundaries', () => {
  it('lists each start and the moment after each end, sorted', () => {
    const json = {
      upcomingPassInformation: [
        event('2030-06-02T10:00:00Z', '2030-06-02T12:00:00Z'),
        event('2030-06-01T10:00:00Z', '2030-06-01T11:00:00Z'),
      ],
    };
    expect(passBoundaries(json)).toEqual([
      at('2030-06-01T10:00:00Z'),
      at('2030-06-01T11:00:00Z') + 1,
      at('2030-06-02T10:00:00Z'),
      at('2030-06-02T12:00:00Z') + 1,
    ]);
  });

  it('ends an event without an end after the fallback', () => {
    const json = { upcomingPassInformation: [event('2030-06-01T10:00:00Z')] };
    const start = at('2030-06-01T10:00:00Z');
    expect(passBoundaries(json)).toEqual([start, start + DEFAULT_EVENT_MINUTES * MIN + 1]);
    expect(passBoundaries(JSON.stringify(json), { fallbackMinutes: 90 })).toEqual([
      start,
      start + 90 * MIN + 1,
    ]);
  });

  it('skips undetermined and malformed events and bad input', () => {
    expect(
      passBoundaries({
        upcomingPassInformation: [{ dateInformation: { isUndetermined: true } }, null, 5],
      }),
    ).toEqual([]);
    expect(passBoundaries('{nope')).toEqual([]);
    expect(passBoundaries(null)).toEqual([]);
    expect(passBoundaries('7')).toEqual([]);
  });

  it('reads any zone offset and fractional seconds as the same instant', () => {
    const start = at('2030-06-01T10:00:00Z');
    for (const date of [
      '2030-06-01T03:00:00-07:00',
      '2030-06-01T15:30:00+05:30',
      '2030-06-01T15:30:00+0530',
      '2030-06-01T10:00:00.000Z',
    ])
      expect(passBoundaries({ upcomingPassInformation: [event(date)] })[0], date).toBe(start);
    const ends = passBoundaries({
      upcomingPassInformation: [event('2030-06-01T03:00:00-07:00', '2030-06-01T16:30:00+05:30')],
    });
    expect(ends).toEqual([start, start + HOUR + 1]);
  });

  it('skips all-day and date-only events: they have no instant of their own', () => {
    expect(
      passBoundaries({
        upcomingPassInformation: [
          { dateInformation: { date: '2030-06-01T00:00:00Z', isAllDay: true } },
          event('2030-06-02'),
        ],
      }),
    ).toEqual([]);
  });

  it('counts the expiry only when asked', () => {
    const json = { expirationDate: '2031-01-01T00:00:00Z' };
    expect(passBoundaries(json)).toEqual([]);
    expect(passBoundaries(json, { expiry: true })).toEqual([at('2031-01-01T00:00:00Z')]);
  });
});

describe('next boundary and phase', () => {
  const list = [10, 20, 30];
  it('finds the first one after now', () => {
    expect(nextBoundary(list, 5)).toBe(10);
    expect(nextBoundary(list, 10)).toBe(20);
    expect(nextBoundary(list, 30)).toBeNull();
  });
  it('counts the ones behind now', () => {
    expect(boundaryPhase(list, 9)).toBe(0);
    expect(boundaryPhase(list, 10)).toBe(1);
    expect(boundaryPhase(list, 99)).toBe(3);
  });
});
