/** Small value conversions the Google bodies need. Pure. */

const ISO =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?)?(Z|[+-]\d{2}:?\d{2})?$/iu;
const ZONE = /(?:Z|[+-]\d{2}:\d{2})$/u;

/** An Apple date as RFC 3339: seconds filled in, a bare date at midnight, the offset as written. */
export function rfc3339(value: string): string | undefined {
  const m = ISO.exec(value.trim());
  if (!m) return undefined;
  const zone = (m[4] ?? '').toUpperCase();
  const offset = /^[+-]\d{4}$/u.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  return `${m[1]}T${m[2] ?? '00:00'}:${m[3] ?? '00'}${offset}`;
}

/** The same instant in UTC (`Z`); a date without an offset is read as UTC, never as local time. */
export function utc(value: string): string | undefined {
  const full = rfc3339(value);
  if (!full) return undefined;
  const time = Date.parse(ZONE.test(full) ? full : `${full}Z`);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString().replace(/\.000Z$/u, 'Z');
}

/** A decimal amount in millionths, exact: `12.5` is `12500000`. Digits beyond six are dropped. */
export function micros(amount: string): string | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(amount.trim());
  if (!m) return undefined;
  const whole = BigInt(`${m[2]}${(m[3] ?? '').slice(0, 6).padEnd(6, '0')}`);
  return `${m[1]}${whole}`;
}

/** `contactVenueWebsite` as `Contact venue website`. */
export function humanize(key: string): string {
  const words = key
    .replace(/URL$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : key;
}

/** A module id from a field path: letters, digits, `.`, `_` and `-` only. */
export const moduleId = (path: string): string => path.replace(/[^A-Za-z0-9._-]/gu, '_');
