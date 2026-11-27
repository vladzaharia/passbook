import { formatDateTimeIn, formatDayIn } from './format.ts';

/** Nov 27, 4:04 AM in the current year of `timeZone`, Nov 27, 2025, 4:04 AM in any other: the short form for a recent moment. */
export function formatRecentDateTimeIn(
  ms: number,
  timeZone: string,
  now: number = Date.now(),
): string {
  const full = formatDateTimeIn(ms, timeZone);
  const year = formatDayIn(ms, timeZone).slice(-4);
  return year === formatDayIn(now, timeZone).slice(-4) ? full.replace(`, ${year}`, '') : full;
}
