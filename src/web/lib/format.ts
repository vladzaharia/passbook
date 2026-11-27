import { NO_EMAIL_LABEL } from '../../shared/email.ts';
import { formatDayIn } from '../../shared/format-date.ts';
import { CALENDAR_ZONE, DEFAULT_TIME_ZONE, isCalendarMidnight } from '../../shared/time-zone.ts';

export { formatClockIn, formatFullIn, formatStampIn } from '../../shared/format-clock.ts';
export { formatEndedOn } from '../../shared/format-date.ts';
export { formatDayIn };

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
  timeZone: CALENDAR_ZONE,
});
const UTC_TIME = new Intl.DateTimeFormat(LOCALE, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: CALENDAR_ZONE,
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

const CALENDAR_DATE = new Intl.DateTimeFormat(LOCALE, {
  timeZone: CALENDAR_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "Fri, Dec 25, 2026" from a `YYYY-MM-DD` key, read as a plain calendar date in any zone. */
export function formatCalendarDate(key: string): string {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number);
  return CALENDAR_DATE.format(Date.UTC(y, m - 1, d));
}

/** Today's `YYYY-MM-DD` on the calendar of a time zone. */
export function todayKey(timeZone: string, now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The `YYYY-MM-DD` key a day before another. */
export function dayBefore(key: string): string {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
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
 * `timeZone` when it is known; otherwise in the zone the timestamp itself carries (its explicit
 * offset), else Seattle time (a Z is how it was written, not a zone), with that zone named so nobody
 * reads it as local time. No DOM: /p renders it.
 */
export function formatExpiry(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  // A date with no time is a calendar day: formatted in UTC it never moves to the day before.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso) || isCalendarMidnight(iso)) {
    return new Intl.DateTimeFormat(LOCALE, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: CALENDAR_ZONE,
    }).format(at);
  }
  const zone = timeZone ?? /([+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? DEFAULT_TIME_ZONE;
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

/** formatRelative, but under 45 seconds either way reads "just now": the one wording for a time that is nearly now. */
export function formatAgo(ms: number, now: number): string {
  return Math.abs(now - ms) < 45_000 ? 'just now' : formatRelative(ms, now);
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

const HEADING = new Map<string, Intl.DateTimeFormat>();

/** "Tue, Nov 17" in `timeZone` when given, else the browser's: a day group's heading. */
export function formatDayHeading(ms: number, timeZone?: string): string {
  const key = timeZone ?? '';
  let day = HEADING.get(key);
  if (!day) {
    day = new Intl.DateTimeFormat(LOCALE, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    });
    HEADING.set(key, day);
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

/** The zone's short name ("EDT") at `ms`, to tell apart the two 1:00 AM hours of a clock change. */
export function formatZoneAbbr(ms: number, timeZone: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(ms)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

/** `rgb(20,26,43)` or `#14dd2b` as `#141A2B`; anything else (a name) as it came. */
export function formatColor(css: string): string {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css.trim());
  if (!m) return css.startsWith('#') ? css.toUpperCase() : css;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** A bare ISO date or date-time as a day (Jan 1, 2026); any other text as it came. */
export function formatMaybeDate(text: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  if (!ISO_DATE.test(text)) return text;
  // A bare date is a calendar day: the reader's zone must not move it. A Z time reads in the org zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) || isCalendarMidnight(text))
    return UTC_DAY.format(Date.parse(text));
  return text.endsWith('Z')
    ? formatDayIn(Date.parse(text), timeZone, LOCALE)
    : formatDay(Date.parse(text));
}

/** `1 tag`, `2 tags`: the noun takes an `s` unless the count is 1. */
export const pluralize = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const SHORT_IN = new Map<string, Intl.DateTimeFormat>();

/** Dec 2, on the calendar of `timeZone`: a deadline ("By Dec 2"). */
export function formatShortDateIn(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  let formatter = SHORT_IN.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', timeZone });
    SHORT_IN.set(timeZone, formatter);
  }
  return formatter.format(ms);
}

export { formatClock, formatSpan, formatStay } from './format-duration.ts';
