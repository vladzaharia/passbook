import { DAYS, parseSpan } from '@/passkit/template/access/hours.ts';
import type { AccessDay, WeeklyHours } from '@/passkit/types.ts';

export { DAYS };

export const DAY_NAME: Record<AccessDay, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
export const DAY_SHORT: Record<AccessDay, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};
export const WEEKDAYS: readonly AccessDay[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
/** Spans a day may hold. */
export const MAX_SPANS = 4;

/** "6 AM", "10:30 PM"; minute 1440 reads as midnight. */
export function clockText(minutes: number): string {
  const m = minutes % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm === 0 ? '' : `:${String(mm).padStart(2, '0')}`} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "6 AM – 10 AM"; a span past midnight reads "10 PM – 2 AM (next day)". */
export function spanText(text: string): string {
  const span = parseSpan(text);
  if (!span) return text;
  return `${clockText(span.start)} – ${clockText(span.end)}${span.end > 1440 ? ' (next day)' : ''}`;
}

/** The two clock times of "HH:MM-HH:MM". */
export function spanParts(text: string): { from: string; to: string } {
  const [from = '', to = ''] = text.split('-');
  return { from, to };
}

export const joinSpan = (from: string, to: string): string => `${from}-${to}`;

/** Why a span cannot be used, or null. */
export function spanProblem(text: string): string | null {
  const { from, to } = spanParts(text);
  if (!from || !to) return 'Set both times.';
  if (from === to) return 'End must differ from start.';
  if (from === '24:00') return 'Start before midnight.';
  return parseSpan(text) ? null : 'Use times like 06:00.';
}

const spansOf = (hours: WeeklyHours | undefined, day: AccessDay): string[] => hours?.[day] ?? [];

/** The first span that overlaps another, with the one it overlaps; a span past midnight spills into the next day. */
function overlap(hours: WeeklyHours, day: AccessDay): [string, string] | null {
  const today = spansOf(hours, day).flatMap((t) => {
    const s = parseSpan(t);
    return s ? [{ t, s: s.start, e: s.end }] : [];
  });
  const at = DAYS.indexOf(day);
  const before = DAYS[(at + 6) % 7] as AccessDay;
  const spill = spansOf(hours, before).flatMap((t) => {
    const s = parseSpan(t);
    return s && s.end > 1440 ? [{ t, s: 0, e: s.end - 1440 }] : [];
  });
  for (const [i, a] of today.entries()) {
    for (const b of [...today.slice(i + 1), ...spill])
      if (a.s < b.e && b.s < a.e) return [a.t, b.t];
  }
  return null;
}

/** Day to message, for the days whose spans overlap. */
export function weekProblems(hours: WeeklyHours | undefined): Partial<Record<AccessDay, string>> {
  const out: Partial<Record<AccessDay, string>> = {};
  if (!hours) return out;
  for (const day of DAYS) {
    const found = overlap(hours, day);
    if (found) out[day] = `${spanText(found[0])} overlaps ${spanText(found[1])}.`;
  }
  return out;
}

/** Hours with one day replaced; no spans closes the day, and no day at all is no hours. */
export function setDay(
  hours: WeeklyHours | undefined,
  day: AccessDay,
  spans: readonly string[],
): WeeklyHours | undefined {
  const next: WeeklyHours = { ...hours };
  if (spans.length > 0) next[day] = [...spans];
  else delete next[day];
  return DAYS.some((d) => next[d]) ? next : undefined;
}

/** Where a day's copy goes: weekdays copy to the other weekdays, a weekend day to its pair. */
export function copyTargets(day: AccessDay): { label: string; days: AccessDay[] } {
  if (WEEKDAYS.includes(day)) return { label: 'weekdays', days: WEEKDAYS.filter((d) => d !== day) };
  const other = day === 'sat' ? 'sun' : 'sat';
  return { label: DAY_NAME[other], days: [other] };
}

export function copyDay(hours: WeeklyHours | undefined, day: AccessDay): WeeklyHours | undefined {
  const spans = spansOf(hours, day);
  let next = hours;
  for (const d of copyTargets(day).days) next = setDay(next, d, spans);
  return next;
}

/** The span a new "Add hours" starts with: after the last one, or a working day. */
export function nextSpan(spans: readonly string[]): string {
  const last = spans.length > 0 ? parseSpan(spans[spans.length - 1]) : null;
  if (!last) return '09:00-17:00';
  const from = Math.min(last.end % 1440 || 0, 22 * 60);
  const to = Math.min(from + 120, 1440);
  const t = (n: number) =>
    n === 1440
      ? '24:00'
      : `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return `${t(from)}-${t(to)}`;
}

/** True when a zone's span has no minute inside the plan's hours that day. */
export function outsidePlan(plan: WeeklyHours | undefined, day: AccessDay, text: string): boolean {
  if (!plan) return false;
  const span = parseSpan(text);
  if (!span) return false;
  const at = DAYS.indexOf(day);
  const before = DAYS[(at + 6) % 7] as AccessDay;
  const open = [
    ...spansOf(plan, day).flatMap((t) => {
      const s = parseSpan(t);
      return s ? [[s.start, s.end] as const] : [];
    }),
    ...spansOf(plan, before).flatMap((t) => {
      const s = parseSpan(t);
      return s && s.end > 1440 ? [[0, s.end - 1440] as const] : [];
    }),
  ];
  return !open.some(([s, e]) => span.start < e && s < span.end);
}
