import { parseSpan } from '@/passkit/template/access/hours.ts';
import type { WeeklyHours } from '@/passkit/types.ts';
import type { SessionHours } from '@/shared/contracts/scanning-sessions.ts';
import {
  DAY_SHORT,
  DAYS,
  spanProblem,
  weekProblems,
} from '../../templates/designer/access/hours.ts';

/** A starting week for the switch: weekdays, working hours. */
export const DEFAULT_HOURS: WeeklyHours = {
  mon: ['09:00-17:00'],
  tue: ['09:00-17:00'],
  wed: ['09:00-17:00'],
  thu: ['09:00-17:00'],
  fri: ['09:00-17:00'],
};

/** Why these hours cannot be saved, or null. Times are the session's wall clock, so no DST case. */
export function hoursProblem(on: boolean, hours: WeeklyHours | undefined): string | null {
  if (!on) return null;
  const spans = DAYS.flatMap((d) => hours?.[d] ?? []);
  if (spans.length === 0) return 'Add at least one span, or turn hours off.';
  for (const text of spans) {
    const bad = spanProblem(text);
    if (bad) return bad;
  }
  return Object.values(weekProblems(hours))[0] ?? null;
}

/** What the server takes: only a valid, switched-on week; null clears the hours. */
export const hoursBody = (on: boolean, hours: WeeklyHours | undefined): SessionHours | null =>
  on && hours && !hoursProblem(on, hours) ? hours : null;

const spanLine = (text: string) => {
  const s = parseSpan(text);
  const [from = '', to = ''] = text.split('-');
  return `${from}–${to}${s && s.end > 1440 ? ' (next day)' : ''}`;
};

/** Days with the same spans read as one line: "Mon–Fri 08:00–22:00", "Sat 10:00–02:00 (next day)". */
export function hoursSummary(hours: SessionHours | null | undefined): string[] {
  if (!hours) return [];
  const lines: { from: number; to: number; text: string }[] = [];
  DAYS.forEach((day, i) => {
    const spans = hours[day];
    if (!spans?.length) return;
    const text = spans.map(spanLine).join(', ');
    const last = lines.at(-1);
    if (last && last.to === i - 1 && last.text === text) last.to = i;
    else lines.push({ from: i, to: i, text });
  });
  return lines.map(({ from, to, text }) => {
    const a = DAY_SHORT[DAYS[from] as keyof typeof DAY_SHORT];
    const b = DAY_SHORT[DAYS[to] as keyof typeof DAY_SHORT];
    return `${from === to ? a : `${a}–${b}`} ${text}`;
  });
}
