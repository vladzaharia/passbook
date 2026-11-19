import { formatZoneAbbr } from '../../../lib/format';

/** "America/New_York" as "New York time"; UTC stays "UTC"; Etc/GMT+5 reads as its real offset. */
export function zoneName(zone: string | null): string {
  if (!zone) return 'your time';
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  if (zone.startsWith('Etc/')) {
    const abbr = formatZoneAbbr(0, zone);
    return `${abbr || zone.slice(4)} time`;
  }
  const city = zone.split('/').pop() ?? zone;
  return `${city.replaceAll('_', ' ')} time`;
}

/** The zone's short name ("EDT"), to tell apart the two 1:00 AM hours of a clock change. */
export const zoneAbbr = formatZoneAbbr;
