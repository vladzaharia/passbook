/** The zone an org without its own `org.timeZone` setting runs on. One value for every caller. */
export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

/** The shown name of the default zone. */
export const DEFAULT_TIME_ZONE_LABEL = 'Pacific Time (Seattle)';

/** The effective org zone: the org's setting, else the default. */
export function resolveOrgTimeZone(setting: string | null | undefined): string {
  return setting || DEFAULT_TIME_ZONE;
}
