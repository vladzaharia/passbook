import { formatTime, formatZoneAbbr } from '../../lib/format.ts';

let sessionZone: string | null = null;

/** The scan screen sets this once per session so every time it shows reads on one clock. */
export function setSessionZone(zone: string | null | undefined) {
  sessionZone = zone ?? null;
}

/** A time in the session's zone; labelled ("4:38 AM UTC") only when that differs from the device's clock. */
export function sessionTime(ms: number, zone: string | null | undefined = sessionZone): string {
  if (!zone) return formatTime(ms);
  const time = formatTime(ms, zone);
  return time === formatTime(ms) ? time : `${time} ${formatZoneAbbr(ms, zone)}`;
}
