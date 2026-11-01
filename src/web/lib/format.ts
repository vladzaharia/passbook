const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

/** The one date-time format of the console: Oct 31, 2026, 6:17 PM. */
export function formatDateTime(ms: number | null | undefined, empty = 'Never'): string {
  return ms == null || ms === 0 ? empty : DATE_TIME.format(ms);
}

/** Oct 31, 2026. */
export function formatDay(ms: number | null | undefined, empty = 'None'): string {
  return ms == null ? empty : DAY.format(ms);
}
