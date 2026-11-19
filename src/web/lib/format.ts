import { NO_EMAIL_LABEL } from '../../shared/email.ts';

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

const EXPIRY = new Map<string, Intl.DateTimeFormat>();

/**
 * "Nov 21, 2030, 11:30 AM" for a pass's expiry (ISO string; '' when it is not a date). In
 * `timeZone` when it is known; otherwise in the zone the timestamp itself carries (its offset, or
 * UTC for Z), with that zone named so nobody reads it as local time. No DOM: /p renders it.
 */
export function formatExpiry(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const zone = timeZone ?? /([+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? 'UTC';
  const named = timeZone === undefined;
  const key = `${zone}|${named}`;
  let formatter = EXPIRY.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
      ...(named ? { timeZoneName: 'short' as const } : {}),
    });
    EXPIRY.set(key, formatter);
  }
  return formatter.format(at);
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

/** "Active now", "Today 3:05 PM", "Yesterday", "Nov 15": one short line for a last-seen time. */
export function formatLastActive(ms: number, now: number): string {
  if (now - ms < 5 * 60_000) return 'Active now';
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return `Today ${formatTime(ms)}`;
  if (days === 1) return 'Yesterday';
  return `Active ${formatShortDate(ms)}`;
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

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

const WEEKDAY = new Map<string, Intl.DateTimeFormat>();

/** "Sat", in `timeZone` when given, else the browser's. */
export function formatWeekday(ms: number, timeZone?: string): string {
  const key = timeZone ?? '';
  let day = WEEKDAY.get(key);
  if (!day) {
    day = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', ...(timeZone ? { timeZone } : {}) });
    WEEKDAY.set(key, day);
  }
  return day.format(ms);
}

/** "Sat 8:00 AM" in a zone: when something opens next. */
export function formatWeekdayTime(ms: number, timeZone: string): string {
  return `${formatWeekday(ms, timeZone)} ${formatTime(ms, timeZone)}`;
}

/** A person's label: the name, else the verified email, else a plain "no email" label. */
export const personLabel = (person: { name: string | null; primaryEmail: string | null }): string =>
  person.name ?? person.primaryEmail ?? NO_EMAIL_LABEL;
