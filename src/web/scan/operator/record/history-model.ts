/** The person's history as data: one line per event, grouped by day in the session's zone. */
import type { HistoryItem } from '../../../../shared/contracts/scan-history.ts';
import { scanLine } from '../../../../shared/copy/scan.ts';
import { reasonHeadline } from '../../../../shared/copy/scan-headline.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { DEFAULT_TIME_ZONE } from '../../../../shared/time-zone.ts';
import {
  dayBefore,
  formatCount,
  formatDayHeading,
  formatTime,
  todayKey,
} from '../../../lib/format.ts';

const H = OPERATOR_COPY.history;

export type Tone = 'ok' | 'out' | 'no' | 'hu' | 'info' | 'muted';
export type Glyph =
  | 'in'
  | 'out'
  | 'refused'
  | 'held'
  | 'let-in'
  | 'undone'
  | 'value'
  | 'note'
  | 'scan';

export interface Line {
  id: string;
  at: number;
  time: string;
  title: string;
  sub: string | null;
  tone: Tone;
  glyph: Glyph;
  struck: boolean;
}

export interface Day {
  key: string;
  heading: string;
  lines: Line[];
}

const join = (parts: (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length ? kept.join(' · ') : null;
};

/** "+1" or "-2": a value change as the desk reads it. */
const signed = (n: number) => `${n > 0 ? '+' : ''}${formatCount(n)}`;

const reasonOf = (item: HistoryItem): string | null =>
  item.reason && item.reason !== 'choose' ? reasonHeadline(item.reason) : null;

export function lineOf(item: HistoryItem, zone?: string): Line {
  const where = join([item.place, item.staff]);
  const base = { id: item.id, at: item.at, time: formatTime(item.at, zone), struck: false };
  switch (item.event) {
    case 'checked_in':
      return { ...base, title: H.checkedIn, sub: where, tone: 'ok', glyph: 'in' };
    case 'checked_out':
      return { ...base, title: H.checkedOut, sub: where, tone: 'out', glyph: 'out' };
    case 'refused':
      return {
        ...base,
        title: reasonOf(item) ?? H.refused,
        sub: where,
        tone: 'no',
        glyph: 'refused',
      };
    case 'held':
      return { ...base, title: reasonOf(item) ?? H.held, sub: where, tone: 'hu', glyph: 'held' };
    case 'let_in':
      return {
        ...base,
        title: item.staff ? scanLine(H.letIn, { staff: item.staff }) : H.letInBy,
        sub: join([reasonOf(item), item.place]),
        tone: 'info',
        glyph: 'let-in',
      };
    case 'undone':
      return { ...base, title: H.undone, sub: where, tone: 'muted', glyph: 'undone', struck: true };
    case 'value':
      return {
        ...base,
        title: item.label ?? H.checkedIn,
        sub: join([item.amount === null ? null : signed(item.amount), item.place, item.staff]),
        tone: 'info',
        glyph: 'value',
      };
    case 'note':
      return { ...base, title: H.noteAdded, sub: item.staff, tone: 'info', glyph: 'note' };
    default:
      return { ...base, title: H.scanned, sub: item.place, tone: 'muted', glyph: 'scan' };
  }
}

/** Newest first, split where the calendar day changes in the zone: Today, Yesterday, then "Tue, Nov 17". */
export function groupDays(
  items: readonly HistoryItem[],
  zone: string | undefined,
  now: number,
): Day[] {
  const tz = zone ?? DEFAULT_TIME_ZONE;
  const today = todayKey(tz, now);
  const yesterday = dayBefore(today);
  const days: Day[] = [];
  for (const item of items) {
    const key = todayKey(tz, item.at);
    let day = days.at(-1);
    if (day?.key !== key) {
      day = {
        key,
        heading:
          key === today ? H.today : key === yesterday ? H.yesterday : formatDayHeading(item.at, tz),
        lines: [],
      };
      days.push(day);
    }
    day.lines.push(lineOf(item, tz));
  }
  return days;
}
