import type { PassJson } from '../../passkit/types.ts';
import type { FormatContext } from './format.ts';
import type { SemanticView } from './types.ts';

type Dict = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const OFFSET = /([+-])(\d{2}):?(\d{2})$/;

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/**
 * The instant and zone a value is shown in. Wallet shows airport and venue times where the place
 * is, so callers pass its zone; without one the offset written in the value is used. Other dates
 * use the viewer's zone.
 */
export function placeDate(
  value: unknown,
  ctx: FormatContext,
  place?: { zone?: unknown; local?: boolean },
): { date: Date; timeZone: string | undefined } | undefined {
  const s = str(value);
  if (!s) return undefined;
  let date = new Date(s);
  if (Number.isNaN(date.getTime())) return undefined;
  let timeZone = ctx.timeZone;
  if (place?.local) {
    const zone = validZone(str(place.zone));
    const m = OFFSET.exec(s);
    if (zone) timeZone = zone;
    else if (m) {
      const minutes = (Number(m[2]) * 60 + Number(m[3])) * (m[1] === '-' ? -1 : 1);
      date = new Date(date.getTime() + minutes * 60_000);
      timeZone = 'UTC';
    }
  }
  return { date, timeZone };
}

function when(
  value: unknown,
  ctx: FormatContext,
  time: boolean,
  place?: { zone?: unknown; local?: boolean },
): string | undefined {
  const at = placeDate(value, ctx, place);
  if (!at) return undefined;
  return new Intl.DateTimeFormat(ctx.locale, {
    month: 'short',
    day: 'numeric',
    ...(time ? { hour: 'numeric', minute: '2-digit' } : { year: 'numeric' }),
    ...(at.timeZone ? { timeZone: at.timeZone } : {}),
  }).format(at.date);
}

/** The card labels this value "Seat", so a bare seat number carries no prefix of its own. */
function seatText(seats: unknown): string | undefined {
  if (!Array.isArray(seats) || !seats.length) return undefined;
  return seats
    .map((s: Dict) => {
      if (!s || typeof s !== 'object') return '';
      const parts = [
        str(s.seatSection) ? `Section ${str(s.seatSection)}` : '',
        str(s.seatRow) ? `Row ${str(s.seatRow)}` : '',
        str(s.seatNumber)
          ? str(s.seatSection) || str(s.seatRow)
            ? `Seat ${str(s.seatNumber)}`
            : str(s.seatNumber)
          : '',
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
    departs: when(s.currentDepartureDate ?? s.originalDepartureDate, ctx, true, {
      zone: s.departureLocationTimeZone,
      local: true,
    }),
    arrives: when(s.currentArrivalDate ?? s.originalArrivalDate, ctx, true, {
      zone: s.destinationLocationTimeZone,
      local: true,
    }),
    gate: str(s.departureGate),
    seat: seatText(s.seats),
    flight: str(s.flightCode),
  };
}
