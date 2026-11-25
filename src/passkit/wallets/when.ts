import { UTC_LABEL } from '../../shared/time-zone.ts';

/**
 * A date or time as text, the way Apple's own styles read it in English, from the pass's own wall
 * clock: no locale lookup, no zone conversion, so a compiler's output never depends on where it
 * runs. `2030-06-01T19:00:00-07:00` with medium styles is `Jun 1, 2030, 7:00 PM`.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const WHEN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/u;
const NONE = 'PKDateStyleNone';

function dateText(y: number, mo: number, d: number, style: string | undefined): string {
  const month = MONTHS[mo - 1] ?? '';
  const weekday = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] ?? '';
  switch (style) {
    case 'PKDateStyleShort':
      return `${mo}/${d}/${String(y).slice(-2)}`;
    case 'PKDateStyleLong':
      return `${month} ${d}, ${y}`;
    case 'PKDateStyleFull':
      return `${weekday}, ${month} ${d}, ${y}`;
    case 'PKDateStyleMedium':
      return `${month.slice(0, 3)} ${d}, ${y}`;
    default:
      return `${weekday.slice(0, 3)}, ${month.slice(0, 3)} ${d}, ${y}`;
  }
}

function zoneText(zone: string): string {
  if (zone === 'Z') return UTC_LABEL;
  const m = /^([+-])(\d{2}):?(\d{2})$/u.exec(zone);
  if (!m) return '';
  const hours = Number(m[2]);
  return `GMT${m[1]}${hours}${m[3] === '00' ? '' : `:${m[3]}`}`;
}

/** Values that are not ISO dates come back unchanged. */
export function formatWhen(value: string, dateStyle?: string, timeStyle?: string): string {
  const m = WHEN.exec(value.trim());
  if (!m) return value;
  const both = dateStyle === undefined && timeStyle === undefined;
  const showDate = both || (dateStyle !== undefined && dateStyle !== NONE);
  const showTime = m[4] !== undefined && (both || (timeStyle !== undefined && timeStyle !== NONE));
  const parts: string[] = [];
  if (showDate) parts.push(dateText(Number(m[1]), Number(m[2]), Number(m[3]), dateStyle));
  if (showTime) {
    const hour = Number(m[4]);
    const clock = `${hour % 12 === 0 ? 12 : hour % 12}:${m[5]} ${hour < 12 ? 'AM' : 'PM'}`;
    const longZone = timeStyle === 'PKDateStyleLong' || timeStyle === 'PKDateStyleFull';
    parts.push(longZone && m[6] ? `${clock} ${zoneText(m[6])}` : clock);
  }
  return parts.join(', ');
}
