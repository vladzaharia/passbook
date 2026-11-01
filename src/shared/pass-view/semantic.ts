import type { PassJson } from '../../passkit/types.ts';
import type { FormatContext } from './format.ts';
import type { SemanticView } from './types.ts';

type Dict = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function when(value: unknown, ctx: FormatContext, time: boolean): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat(ctx.locale, {
    month: 'short',
    day: 'numeric',
    ...(time ? { hour: 'numeric', minute: '2-digit' } : { year: 'numeric' }),
    ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}),
  }).format(d);
}

function seatText(seats: unknown): string | undefined {
  if (!Array.isArray(seats) || !seats.length) return undefined;
  return seats
    .map((s: Dict) => {
      if (!s || typeof s !== 'object') return '';
      const parts = [
        str(s.seatSection) ? `Section ${str(s.seatSection)}` : '',
        str(s.seatRow) ? `Row ${str(s.seatRow)}` : '',
        str(s.seatNumber) ? `Seat ${str(s.seatNumber)}` : '',
      ].filter(Boolean);
      return parts.length ? parts.join(', ') : (str(s.seatIdentifier) ?? '');
    })
    .filter(Boolean)
    .join('; ');
}

/** Poster event tickets lay out from semantics (Wallet ignores most fields there). */
export function eventSemantics(pass: PassJson, ctx: FormatContext): SemanticView | undefined {
  const s = (pass.semantics ?? {}) as Dict;
  const view: SemanticView = {
    kind: 'event',
    title: str(s.eventName),
    date: when(s.eventStartDate, ctx, true),
    venue: str(s.venueName),
    seats: seatText(s.seats),
    admission: str(s.admissionLevel),
  };
  return Object.values(view).filter(Boolean).length > 1 ? view : undefined;
}

/** Semantic boarding passes: airports, times, gate and seat from semantics. */
export function flightSemantics(pass: PassJson, ctx: FormatContext): SemanticView | undefined {
  const s = (pass.semantics ?? {}) as Dict;
  const from = str(s.departureAirportCode);
  const to = str(s.destinationAirportCode);
  if (!from && !to) return undefined;
  return {
    kind: 'flight',
    from,
    fromName: str(s.departureCityName) ?? str(s.departureAirportName),
    to,
    toName: str(s.destinationCityName) ?? str(s.destinationAirportName),
    departs: when(s.currentDepartureDate ?? s.originalDepartureDate, ctx, true),
    arrives: when(s.currentArrivalDate ?? s.originalArrivalDate, ctx, true),
    gate: str(s.departureGate),
    seat: seatText(s.seats),
    flight: str(s.flightCode),
  };
}
