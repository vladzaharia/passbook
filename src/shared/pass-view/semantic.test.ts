import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { eventSemantics, flightSemantics } from './semantic.ts';
import type { SemanticView } from './types.ts';

const ctx = { locale: 'en-US', now: new Date('2026-01-01T00:00:00Z'), timeZone: 'UTC' };
const pass = (semantics: Record<string, unknown>) => ({ semantics }) as unknown as PassJson;

function event(view: SemanticView | undefined) {
  if (view?.kind !== 'event') throw new Error('expected an event view');
  return view;
}
function flight(view: SemanticView | undefined) {
  if (view?.kind !== 'flight') throw new Error('expected a flight view');
  return view;
}

describe('eventSemantics', () => {
  it('lays out name, date, venue, seats and admission', () => {
    const view = event(
      eventSemantics(
        pass({
          eventName: ' Finals ',
          eventStartDate: '2026-06-01T19:30:00Z',
          venueName: 'Arena',
          seats: [{ seatSection: 'A', seatRow: '3', seatNumber: '9' }, { seatIdentifier: 'GA' }],
          admissionLevel: 'VIP',
        }),
        ctx,
      ),
    );
    expect(view).toMatchObject({
      title: 'Finals',
      venue: 'Arena',
      seats: 'Section A, Row 3, Seat 9; GA',
      admission: 'VIP',
    });
    expect(view.date).toContain('7:30');
  });

  it('is undefined without any semantic field', () => {
    expect(eventSemantics(pass({}), ctx)).toBeUndefined();
  });

  it('drops a date it cannot read', () => {
    const view = event(
      eventSemantics(pass({ eventName: 'X', venueName: 'Y', eventStartDate: 'soon' }), ctx),
    );
    expect(view.date).toBeUndefined();
  });
});

describe('flightSemantics', () => {
  it('needs an airport', () => {
    expect(flightSemantics(pass({ flightCode: 'UA1' }), ctx)).toBeUndefined();
  });

  it('prefers current times and city names', () => {
    const view = flight(
      flightSemantics(
        pass({
          departureAirportCode: 'SEA',
          destinationAirportCode: 'SFO',
          departureCityName: 'Seattle',
          destinationAirportName: 'San Francisco Intl',
          originalDepartureDate: '2026-06-01T08:00:00Z',
          currentDepartureDate: '2026-06-01T09:15:00Z',
          departureGate: 'B4',
          flightCode: 'UA1',
        }),
        ctx,
      ),
    );
    expect(view).toMatchObject({
      from: 'SEA',
      fromName: 'Seattle',
      to: 'SFO',
      toName: 'San Francisco Intl',
      gate: 'B4',
      flight: 'UA1',
    });
    expect(view.departs).toContain('9:15');
  });
});
