/** Zoned calendar time on `Intl` only. Days are calendar days; a day is 23 or 25 h on change days. */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at `t`, read as if it were UTC. */
function wallAsUtc(t: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(t)))
    p[part.type] = Number(part.value);
  return Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
}

const offsetAt = (t: number, timeZone: string) =>
  wallAsUtc(t, timeZone) - Math.floor(t / 1000) * 1000;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DD` on the wall clock in `timeZone`. */
export function localDate(ms: number, timeZone: string): string {
  return new Date(wallAsUtc(ms, timeZone)).toISOString().slice(0, 10);
}

/** Calendar arithmetic on `YYYY-MM-DD`; never a multiple of 86 400 000 ms in a zone. */
export function addDays(isoDate: string, n: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export const isLeapYear = (year: number) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * The instant `HH:MM` on `isoDate` in `timeZone`. A time inside a spring-forward gap gives the first
 * valid instant after the gap; a time that occurs twice gives the earlier one.
 */
export function zonedInstant(isoDate: string, hhmm: string, timeZone: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  const wall = Date.parse(`${isoDate}T${pad(Number(h))}:${pad(Number(m))}:00Z`);
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const valid = [wall - before, wall - after].filter((c) => wallAsUtc(c, timeZone) === wall);
  if (valid.length > 0) return Math.min(...valid);
  // Gap: the offset changes between `wall - after` and `wall - before`. Find the first instant with the new offset.
  let lo = Math.min(wall - before, wall - after);
  let hi = Math.max(wall - before, wall - after);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (offsetAt(mid, timeZone) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

export const startOfDay = (isoDate: string, timeZone: string) =>
  zonedInstant(isoDate, '00:00', timeZone);

/** `[start, end)` of a local day. */
export function dayRange(isoDate: string, timeZone: string): [number, number] {
  return [startOfDay(isoDate, timeZone), startOfDay(addDays(isoDate, 1), timeZone)];
}

export const monthDay = (isoDate: string) => isoDate.slice(5);
export const yearOf = (isoDate: string) => Number(isoDate.slice(0, 4));
