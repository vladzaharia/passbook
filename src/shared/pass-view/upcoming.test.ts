import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { assets, eventTicket, seasonTicket } from './fixtures/index.ts';
import { normalize } from './normalize.ts';

const now = new Date('2026-10-31T12:00:00Z');
const view = (p: PassJson, timeZone = 'UTC') => normalize(p, { assets, now, timeZone });

describe('upcoming events', () => {
  it('is empty without upcomingPassInformation', () => {
    expect(view(eventTicket).upcoming).toEqual([]);
  });

  it('shows each date where the event is, whatever the viewer zone', () => {
    for (const zone of ['UTC', 'Asia/Tokyo']) {
      const [first, second] = view(seasonTicket, zone).upcoming;
      expect(first).toMatchObject({ id: 'g1', month: 'Oct', day: '31', active: true });
      expect(first?.when).toBe('Sat, 11:00 AM');
      expect(first?.venue).toBe('Main Park');
      expect(second).toMatchObject({ month: 'Nov', day: '7', venue: 'Harbor Arena' });
      expect(second?.when).toBe('Sat, 7:30 PM');
    }
  });

  it('marks events without a date', () => {
    const last = view(seasonTicket).upcoming[2];
    expect(last).toMatchObject({ name: 'Finale', dated: false, when: 'Date to be announced' });
    expect(last?.dateTime).toBeUndefined();
  });

  it('skips entries that are not events and shows all-day events without a time', () => {
    const p = {
      ...eventTicket,
      upcomingPassInformation: [
        null,
        { identifier: 'x' },
        {
          identifier: 'd',
          name: 'Open day',
          type: 'event',
          dateInformation: { date: '2026-12-01T00:00:00Z', isAllDay: true, timeZone: 'UTC' },
        },
      ],
    } as unknown as PassJson;
    const rows = view(p).upcoming;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.when).toBe('Tue, Dec 1');
  });
});
