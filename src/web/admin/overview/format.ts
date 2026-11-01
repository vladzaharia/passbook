export { formatDateTime, formatDay } from '../../lib/format.ts';

const COUNT = new Intl.NumberFormat();

export function formatCount(n: number): string {
  return COUNT.format(n);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function formatRelative(ms: number, now: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diff = ms - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(0, 'minute');
}

/** Whole days until `ms`; negative when past. */
export function daysUntil(ms: number, now: number): number {
  return Math.floor((ms - now) / 86_400_000);
}
