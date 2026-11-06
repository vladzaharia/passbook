// Every date and number a person reads in the app, in one locale. Engines join a date and a time
// differently ("Nov 2, 2026, 11:51 PM" in Chromium, "… at 11:51 PM" in WebKit), so the parts are
// formatted apart and joined here.
const LOCALE = 'en-US';

const DAY = new Intl.DateTimeFormat(LOCALE, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const SHORT = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat(LOCALE, {
  hour: 'numeric',
  minute: '2-digit',
});
const ZONED_TIME = new Map<string, Intl.DateTimeFormat>();
const HOUR = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric' });
const UTC_DAY = new Intl.DateTimeFormat(LOCALE, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const UTC_TIME = new Intl.DateTimeFormat(LOCALE, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const COUNT = new Intl.NumberFormat(LOCALE);
const MONEY = new Map<string, Intl.NumberFormat>();
const RELATIVE = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/** The one date-time format of the app: Oct 31, 2026, 6:17 PM. */
export function formatDateTime(ms: number | null | undefined, empty = 'Never'): string {
  return ms == null || ms === 0 ? empty : `${DAY.format(ms)}, ${TIME.format(ms)}`;
}

/** Oct 31, 2026. */
export function formatDay(ms: number | null | undefined, empty = 'None'): string {
  return ms == null ? empty : DAY.format(ms);
}

/** Oct 31: axes, ranges, "Updated Oct 31". */
export function formatShortDate(ms: number): string {
  return SHORT.format(ms);
}

/** 6:17 PM. */
export function formatTime(ms: number, timeZone?: string): string {
  if (!timeZone) return TIME.format(ms);
  let formatter = ZONED_TIME.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit', timeZone });
    ZONED_TIME.set(timeZone, formatter);
  }
  return formatter.format(ms);
}

/** Oct 31, 6 PM: a bucket an hour wide or more. */
export function formatShortDateHour(ms: number): string {
  return `${SHORT.format(ms)}, ${HOUR.format(ms)}`;
}

/** "Nov 15, 2026, 4:08 AM" from a datetime-local string (wall time, no zone shift). */
export function formatWallTime(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return '';
  const [, y, mo, d, h, mi] = m.map(Number) as number[];
  const ms = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  return `${UTC_DAY.format(ms)}, ${UTC_TIME.format(ms)}`;
}

/** 1,234. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

/** $42.50, or -$12.00 / +$12.00 with `signed`. No currency: a plain two-decimal number. */
export function formatMoney(amount: number, currency: string | null, signed = false): string {
  let f = MONEY.get(currency ?? '');
  if (!f) {
    f = new Intl.NumberFormat(
      LOCALE,
      currency
        ? { style: 'currency', currency }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    );
    MONEY.set(currency ?? '', f);
  }
  const text = f.format(Math.abs(amount));
  if (amount < 0) return `\u2212${text}`;
  return signed && amount > 0 ? `+${text}` : text;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 hours ago", "in 2 days", "now". */
export function formatRelative(ms: number, now: number): string {
  const diff = ms - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return RELATIVE.format(Math.round(diff / size), unit);
  }
  return RELATIVE.format(0, 'minute');
}

/** Whole days until `ms`; negative when past. */
export function daysUntil(ms: number, now: number): number {
  return Math.floor((ms - now) / 86_400_000);
}

/** Event time always uses the event's zone, with the abbreviation when it differs. */
export function formatEventTime(ms: number, timeZone: string): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    ...(local !== timeZone ? { timeZoneName: 'short' as const } : {}),
  }).format(ms);
}
