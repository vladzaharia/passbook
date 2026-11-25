// Dates a holder reads about their pass, in the holder's zone. In shared/ so the Worker (/p, /b) and
// the SPA use one implementation; web/lib/format.ts re-exports both.
import { CALENDAR_ZONE, DEFAULT_TIME_ZONE, isCalendarMidnight } from './time-zone.ts';

const cache = new Map<string, Intl.DateTimeFormat>();

/** Oct 31, 2026 in `timeZone`: the day a holder sees something happened, in the holder's own zone. */
export function formatDayIn(ms: number, timeZone: string, locale = 'en-US'): string {
  const key = `${locale}|${timeZone}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    });
    cache.set(key, formatter);
  }
  return formatter.format(ms);
}

/**
 * The day a voided or expired pass stopped working: the expiry the pass names (expired), else the
 * recorded void time, else the day it last changed. One rule for the portal, /p and /b: the
 * visitor's zone (the browser's; Cloudflare's on the server, UTC without one) and language.
 * Null when there is no date.
 */
export function formatEndedOn(
  state: 'voided' | 'expired',
  pass: { modifiedAt: number; voidedAt?: number | null; expirationDate?: unknown },
  timeZone = DEFAULT_TIME_ZONE,
  locale = 'en-US',
): string | null {
  const expiry = typeof pass.expirationDate === 'string' ? Date.parse(pass.expirationDate) : NaN;
  const at =
    state === 'expired' && Number.isFinite(expiry) ? expiry : (pass.voidedAt ?? pass.modifiedAt);
  if (!Number.isFinite(at)) return null;
  // A date-only expiry is a calendar day, not an instant: UTC keeps it from showing a day early.
  const dateOnly =
    state === 'expired' &&
    typeof pass.expirationDate === 'string' &&
    (/^\d{4}-\d{2}-\d{2}$/.test(pass.expirationDate) || isCalendarMidnight(pass.expirationDate));
  try {
    return formatDayIn(at, dateOnly ? CALENDAR_ZONE : timeZone, locale);
  } catch {
    return null;
  }
}
