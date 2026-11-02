import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { assets, boardingPass } from './fixtures/index.ts';
import { normalize } from './normalize.ts';

const now = new Date('2026-10-31T12:00:00Z');
const pass = (semantics: Record<string, unknown>) =>
  ({
    ...boardingPass,
    preferredStyleSchemes: ['semanticBoardingPass', 'boardingPass'],
    semantics: { departureAirportCode: 'SFO', destinationAirportCode: 'JFK', ...semantics },
  }) as PassJson;
const flight = (p: PassJson, timeZone: string) => {
  const s = normalize(p, { assets, now, timeZone, target: 'ios27' }).layout.semantic;
  return s?.kind === 'flight' ? s : undefined;
};

describe('flight semantics', () => {
  const base = {
    originalDepartureDate: '2030-06-01T08:00:00-07:00',
    originalArrivalDate: '2030-06-01T16:30:00-04:00',
  };

  it.each(['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])('shows airport times in %s', (zone) => {
    const s = flight(
      pass({
        ...base,
        departureLocationTimeZone: 'America/Los_Angeles',
        destinationLocationTimeZone: 'America/New_York',
      }),
      zone,
    );
    expect(s?.departs).toBe('Jun 1, 8:00 AM');
    expect(s?.arrives).toBe('Jun 1, 4:30 PM');
  });

  it('falls back to the written offset', () => {
    const s = flight(pass(base), 'Asia/Tokyo');
    expect(s?.departs).toBe('Jun 1, 8:00 AM');
    expect(s?.arrives).toBe('Jun 1, 4:30 PM');
  });

  it('does not repeat the Seat label or the header gate', () => {
    const p = pass({ ...base, departureGate: 'B12', seats: [{ seatNumber: '14A' }] });
    const s = flight(p, 'UTC');
    expect(s?.seat).toBe('14A');
    const layout = normalize(p, { assets, now, timeZone: 'UTC', target: 'ios27' }).layout;
    expect(layout.header.map((f) => f.text)).not.toContain('B12');
    expect(s?.gate).toBe('B12');
  });
});
