/** The zone an org without its own `org.timeZone` setting runs on. One value for every caller. */
export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

/**
 * The zone a calendar date (no time of day, stored at 00:00Z) or a timestamp's own `Z` is read in,
 * so it never shifts a day. Not a zone choice: "no zone known" is `DEFAULT_TIME_ZONE`.
 */
export const CALENDAR_ZONE = 'UTC';

/** The shown name of the default zone. */
export const DEFAULT_TIME_ZONE_LABEL = 'Pacific Time (Seattle)';

/** The effective org zone: the org's setting, else the default. */
export function resolveOrgTimeZone(setting: string | null | undefined): string {
  return setting || DEFAULT_TIME_ZONE;
}

/** The name shown for a `Z` offset. */
export const UTC_LABEL = 'UTC';

/**
 * A date stored as midnight UTC (`2030-01-01T00:00:00Z`, with or without `.000`) is a calendar
 * date, not an instant: it reads as that day in every zone.
 */
export const isCalendarMidnight = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?Z$/.test(value);
