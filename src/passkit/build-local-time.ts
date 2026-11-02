/**
 * Wallet shows an ignoresTimeZone date as the wall clock written in the value, so a UTC instant
 * ("2026-11-17T01:00:00Z") reads as the next day at 1 AM for a 5 PM Seattle event. Before
 * signing, such values are rewritten with the venue's offset ("2026-11-16T17:00:00-08:00").
 */
import type { PassJson, Personalization } from './types.ts';

const STYLES = ['boardingPass', 'coupon', 'eventTicket', 'generic', 'storeCard'] as const;
const GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
] as const;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const CALENDAR_DATE = /T00:00(?::00(?:\.0+)?)?Z$/;

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes east of UTC that `zone` uses at `ms`. */
export function offsetMinutes(ms: number, zone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');

/** The instant as local wall clock with its offset, whole seconds: "2026-11-16T17:00:00-08:00". */
export function toLocalIso(ms: number, zone: string): string {
  const off = offsetMinutes(ms, zone);
  const wall = new Date(Math.floor(ms / 1000) * 1000 + off * 60_000).toISOString().slice(0, 19);
  return `${wall}${off < 0 ? '-' : '+'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** Input properties marked `"x-timeZone": true` name the local zone for the pass's dates. */
export function inputTimeZone(
  schema: unknown,
  input: Personalization,
): { key: string; zone: string | undefined } | undefined {
  const props = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const key = Object.keys(props).find((k) => isObject(props[k]) && props[k]['x-timeZone'] === true);
  if (!key) return undefined;
  const value = input[key];
  return { key, zone: typeof value === 'string' && value !== '' ? value : undefined };
}

export interface LocalZones {
  /** Zone for every ignoresTimeZone field. */
  zone?: string | undefined;
  /** Zone for fields whose key mentions arrival (boarding passes). */
  arrival?: string | undefined;
}

/** The zone from an input, else the boarding pass's departure and arrival zones. */
export function localZones(pass: PassJson, inputZone: string | undefined): LocalZones {
  const semantics = isObject(pass.semantics) ? pass.semantics : {};
  const departure = isTimeZone(semantics.departureLocationTimeZone)
    ? semantics.departureLocationTimeZone
    : undefined;
  const arrival = isTimeZone(semantics.destinationLocationTimeZone)
    ? semantics.destinationLocationTimeZone
    : undefined;
  const zone = inputZone ?? departure;
  return { zone, arrival: arrival ?? zone };
}

/** Rewrites ignoresTimeZone date values in place. Calendar dates (midnight UTC, no time) stay. */
export function localizeDates(pass: PassJson, zones: LocalZones): void {
  if (!zones.zone && !zones.arrival) return;
  for (const style of STYLES) {
    const dict = (pass as Loose)[style];
    if (!isObject(dict)) continue;
    for (const group of GROUPS) {
      const fields = dict[group];
      if (!Array.isArray(fields)) continue;
      for (const field of fields) {
        if (!isObject(field) || field.ignoresTimeZone !== true) continue;
        const value = field.value;
        if (typeof value !== 'string' || !ISO.test(value)) continue;
        if (field.timeStyle === 'PKDateStyleNone' && CALENDAR_DATE.test(value)) continue;
        const zone = /arriv/i.test(String(field.key)) ? zones.arrival : zones.zone;
        const ms = Date.parse(value);
        if (zone && !Number.isNaN(ms)) field.value = toLocalIso(ms, zone);
      }
    }
  }
}
