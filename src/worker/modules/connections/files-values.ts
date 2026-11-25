import { TABULAR_LIMITS, TabularError } from '../../../shared/tabular/index.ts';

export const DEFAULT_ZONE = 'America/Los_Angeles';
const ZONELESS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

const formats = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number>();
const HOUR = 3_600_000;

const formatOf = (zone: string): Intl.DateTimeFormat => {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(zone, f);
  }
  return f;
};

/** The zone's offset (ms) at `instant`. A formatter per zone, and one answer per zone and UTC hour: offsets only move on the hour. */
function offsetAt(instant: number, zone: string): number {
  const key = `${zone}|${Math.floor(instant / HOUR)}`;
  const hit = offsets.get(key);
  if (hit !== undefined) return hit;
  const parts = formatOf(zone).formatToParts(new Date(instant));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  const offset = local - Math.floor(instant / 1000) * 1000;
  if (offsets.size > 50_000) offsets.clear();
  offsets.set(key, offset);
  return offset;
}

/** `2026-10-31T11:00:00` read in `zone`, written with that zone's offset on that day. */
export function inZone(text: string, zone: string): string {
  const m = ZONELESS.exec(text);
  if (!m) return text;
  const [, y, mo, d, h, mi, s = '00', frac = ''] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let utc = wall;
  for (let i = 0; i < 2; i++) utc = wall - offsetAt(utc, zone);
  const minutes = Math.round(offsetAt(utc, zone) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function knows(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone, or the default when the runtime does not know it. */
export function usableZone(zone: string | null): string {
  return zone && knows(zone) ? zone : DEFAULT_ZONE;
}

/**
 * A copy of a cell value for storage. Zone-less datetimes (XLSX dates, JSON text) are read in the org's zone,
 * never UTC. Strings are length-checked at any depth, since the parser checks top-level cells only. Objects are
 * rebuilt with `fromEntries`, so an own `__proto__` key stays a plain key.
 */
export function storable(value: unknown, zone: string): unknown {
  if (typeof value === 'string') {
    if (value.length > TABULAR_LIMITS.cellChars)
      throw new TabularError('FILE_CELL_TOO_LONG', 'A value has more than 2,000 characters.');
    return inZone(value, zone);
  }
  if (Array.isArray(value)) return value.map((v) => storable(v, zone));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, storable(v, zone)] as const),
    );
  return value;
}
