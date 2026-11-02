/** Time zone choices: "Los Angeles (PT)" for display, the IANA id as the value. */
export interface ZoneOption {
  value: string;
  label: string;
}

function generic(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    // An id the runtime does not know: no abbreviation.
    return '';
  }
}

/** "America/Los_Angeles" -> "Los Angeles (PT)"; UTC stays "UTC". */
export function zoneLabel(zone: string): string {
  if (zone === 'UTC') return 'UTC';
  const city = (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
  const abbr = generic(zone);
  return abbr ? `${city} (${abbr})` : city;
}

let cached: ZoneOption[] | undefined;

/** Every zone the runtime knows, labelled; computed once. */
export function zoneOptions(): ZoneOption[] {
  if (cached) return cached;
  const ids =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  cached = (ids.includes('UTC') ? ids : ['UTC', ...ids]).map((value) => ({
    value,
    label: zoneLabel(value),
  }));
  return cached;
}

export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
