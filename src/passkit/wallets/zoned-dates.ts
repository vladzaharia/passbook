import { instantOf } from '../behaviors/term/calendar.ts';

const OFFSETLESS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/** A date-time with no offset, written in `timeZone`, with that zone's offset; Z and offsets stay as written. */
function zoned(value: string, timeZone: string): string {
  const m = OFFSETLESS.exec(value);
  if (!m) return value;
  const wall = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6] ?? 0),
  };
  const at = instantOf(wall, timeZone);
  const minutes = Math.round(
    (Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s) - at) / 60_000,
  );
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${pad(wall.s)}${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function withZone<T>(value: T, timeZone: string): T {
  if (typeof value === 'string') return zoned(value, timeZone) as T;
  if (Array.isArray(value)) return value.map((v) => withZone(v, timeZone)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withZone(v, timeZone)]),
    ) as T;
  return value;
}
