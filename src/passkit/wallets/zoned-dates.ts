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

function withZone<T>(value: T, timeZone: string): T {
  if (typeof value === 'string') return zoned(value, timeZone) as T;
  if (Array.isArray(value)) return value.map((v) => withZone(v, timeZone)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withZone(v, timeZone)]),
    ) as T;
  return value;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const STYLES = ['eventTicket', 'boardingPass', 'storeCard', 'coupon', 'generic', 'posterGeneric'];
const FIELD_GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
];

/**
 * The pass with offsetless date-times read in `timeZone`: only the places that hold a date (expiry,
 * relevance, dated semantics, fields with a date or time style), never free text.
 */
export function zonedPass<T extends Obj>(pass: T, timeZone: string): T {
  const out: Obj = { ...pass };
  for (const key of ['expirationDate', 'relevantDate'])
    if (typeof out[key] === 'string') out[key] = zoned(out[key], timeZone);
  if (Array.isArray(out.relevantDates))
    out.relevantDates = out.relevantDates.map((d) => withZone(d, timeZone));
  if (isObj(out.semantics))
    out.semantics = Object.fromEntries(
      Object.entries(out.semantics).map(([k, v]) => [
        k,
        /(?:Date|Time)$/.test(k) ? withZone(v, timeZone) : v,
      ]),
    );
  for (const style of STYLES) {
    const block = out[style];
    if (!isObj(block)) continue;
    const next: Obj = { ...block };
    for (const group of FIELD_GROUPS)
      if (Array.isArray(next[group]))
        next[group] = next[group].map((f) =>
          isObj(f) && (f.dateStyle !== undefined || f.timeStyle !== undefined)
            ? { ...f, value: withZone(f.value, timeZone) }
            : f,
        );
    out[style] = next;
  }
  return out as T;
}

/** The inputs with the keys the schema types as `date-time` read in `timeZone`; the rest stay as typed. */
export function zonedInput<T extends Obj>(
  input: T,
  dateTimeKeys: ReadonlySet<string>,
  timeZone: string,
): T {
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, dateTimeKeys.has(k) ? withZone(v, timeZone) : v]),
  ) as T;
}
