import { hoursText } from '@/passkit/template/access/scope.ts';
import type { WeeklyHours } from '@/passkit/types.ts';
import type { SessionHours } from '@/shared/contracts/scanning-sessions.ts';
import { dayBefore, formatCalendarDate, todayKey } from '@/web/lib/format.ts';
import { DAYS, spanProblem, spanText, weekProblems } from '@/web/ui/week-grid/hours.ts';

/** A starting week for the switch: weekdays, working hours. */
export const DEFAULT_HOURS: WeeklyHours = {
  mon: ['09:00-17:00'],
  tue: ['09:00-17:00'],
  wed: ['09:00-17:00'],
  thu: ['09:00-17:00'],
  fri: ['09:00-17:00'],
};

/** Why these hours cannot be saved, or null. Times are the session's wall clock, so no DST case. */
export function hoursProblem(on: boolean, hours: WeeklyHours | undefined): string | null {
  if (!on) return null;
  const spans = DAYS.flatMap((d) => hours?.[d] ?? []);
  if (spans.length === 0) return 'Add at least one span, or turn hours off.';
  for (const text of spans) {
    const bad = spanProblem(text);
    if (bad) return bad;
  }
  return Object.values(weekProblems(hours))[0] ?? null;
}

/** What the server takes: only a valid, switched-on week; null clears the hours. */
export const hoursBody = (
  on: boolean,
  hours: WeeklyHours | undefined,
  dates?: Record<string, string[]>,
  timeZone?: string,
): SessionHours | null => {
  if (!on || !hours || hoursProblem(on, hours)) return null;
  // Yesterday still counts (an overnight span); anything older is dropped, as the server does.
  const earliest = timeZone ? dayBefore(todayKey(timeZone)) : '';
  const live = Object.entries(dates ?? {}).filter(([key]) => key >= earliest);
  return { ...hours, ...(live.length > 0 ? { dates: Object.fromEntries(live) } : {}) };
};

/** The weekly part of stored hours, for the week grid. */
export const weekOf = ({ dates: _dates, ...week }: SessionHours): WeeklyHours => week;

/**
 * Days with the same spans read as one line: "Mon–Fri 9 AM–5 PM", as the access summaries do,
 * then one line per dated exception: "Dec 25: Closed".
 */
export const hoursSummary = (hours: SessionHours | null | undefined): string[] => {
  if (!hours) return [];
  const exceptions = Object.entries(hours.dates ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([key, spans]) =>
        `${formatCalendarDate(key)}: ${spans.length ? spans.map(spanText).join(', ') : 'Closed'}`,
    );
  return [...hoursText(hours).split(' · ').filter(Boolean), ...exceptions];
};
