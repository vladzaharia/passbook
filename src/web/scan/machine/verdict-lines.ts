/** The verdict line of an outcome, filled from the outcome alone. Pure: every marker has a value. */
import {
  SCAN_COUNTER_COPY,
  SCAN_REASON_COPY,
  SCAN_REASON_VARIANTS,
  type ScanLine,
  scanLine,
} from '../../../shared/copy/scan.ts';
import { headlineValues } from '../../../shared/copy/scan-headline.ts';
import { formatCount, formatDateTime, formatMoney, formatTime } from '../../lib/format.ts';
import { accessValues, agoText } from './access-view.ts';
import type { ScanOutcome } from './types.ts';

type Values = Record<string, string | number>;
type Value = NonNullable<ScanOutcome['value']>;

const WEEKDAY = new Map<string, Intl.DateTimeFormat>();
/** Sat, in the event's zone when it has one. */
function weekday(ms: number, timeZone?: string): string {
  const key = timeZone ?? '';
  let f = WEEKDAY.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { weekday: 'short', ...(timeZone ? { timeZone } : {}) });
    WEEKDAY.set(key, f);
  }
  return f.format(ms);
}

/** A value as staff read it: money with its currency, a count with separators, text as is. */
function shown(value: Value, n: unknown): string {
  if (typeof n === 'number')
    return value.format === 'currency' ? formatMoney(n, value.currency ?? null) : formatCount(n);
  if (typeof n === 'string') return n;
  return n === null || n === undefined ? '' : JSON.stringify(n);
}

/** Every marker the copy names, from `value`, `access`, `previous`, `event` and the counts. */
export function lineValues(o: ScanOutcome, now: number): Values {
  const v = o.value;
  const place = o.occupancy?.place.name ?? o.event?.name;
  return {
    template: o.template?.name ?? 'This pass',
    event: o.event?.name ?? '',
    // `not_yet_valid` opens at `at` (the pass's own start); only a wrong event names the event's day.
    day:
      o.reason !== 'wrong_event' && o.at
        ? weekday(o.at)
        : o.event
          ? weekday(o.event.startsAt)
          : o.at
            ? weekday(o.at)
            : '',
    date: formatDateTime(o.at),
    time: o.at ? formatTime(o.at) : '',
    ago: o.previous ? agoText(Math.max(0, now - o.previous.at)) : '',
    scanner: o.previous?.scannerName ?? (o.reason === 'still_inside' ? 'Entry recorded' : ''),
    in: o.occupancy ? (o.occupancy.inNow ?? 0) : (o.counts.event?.arrived ?? 0),
    capacity: o.occupancy?.capacity ?? o.counts.event?.capacity ?? 0,
    seconds: Math.ceil((o.retryAfterMs ?? 1000) / 1000),
    wait: `${Math.max(1, Math.ceil((o.cooldownRemainingMs ?? 0) / 60000))} min`,
    have: v ? shown(v, v.before) : '',
    need: v ? shown(v, v.need ?? null) : '',
    value: v ? shown(v, v.after ?? v.before) : '',
    used: o.access?.visits?.used ?? 0,
    limit: o.access?.visits?.limit ?? 0,
    ...headlineValues({
      actionKind: o.action?.kind,
      action: o.action?.label,
      place,
      flag: o.flags[0],
      input: v?.label,
    }),
    plan: 'This plan',
    zone: 'this area',
    when: '',
    ...accessValues(o, now),
  };
}

/** The reason's copy, or the variant for a reason whose outcome lacks what the main line names. */
function pick(o: ScanOutcome, desk: boolean): ScanLine | null {
  const reason = o.reason;
  if (!reason) return null;
  const line = SCAN_REASON_COPY[reason];
  const v = SCAN_REASON_VARIANTS;
  const counter = o.value?.counter ? SCAN_COUNTER_COPY[reason] : undefined;
  if (counter) return counter;
  if (reason === 'needs_approval' && desk) return v.needs_approval;
  if (reason === 'already_done' && !o.previous) return { ...line, sub: v.already_done.noPrevious };
  if (reason === 'wrong_event' && !o.event) return { ...line, sub: v.wrong_event.noEvent };
  if (reason === 'not_yet_valid' && !o.at && !o.event)
    return { ...line, sub: v.not_yet_valid.noWhen };
  if (reason === 'ended' && !o.event) return { headline: v.ended.noPlace, sub: line.sub };
  if (reason === 'capacity_full') {
    const place = o.occupancy?.place.name ?? o.event?.name;
    const known = o.occupancy
      ? o.occupancy.inNow != null && o.occupancy.capacity != null
      : o.counts.event?.capacity != null;
    return {
      headline: place ? line.headline : v.capacity_full.noPlace,
      sub: known
        ? line.sub
        : o.occupancy && o.occupancy.inNow == null
          ? v.capacity_full.noCount
          : v.capacity_full.noCapacity,
    };
  }
  if (reason === 'outside_hours' && !o.access?.nextOpenAt)
    return { ...line, sub: v.outside_hours.noHours };
  if (reason === 'zone_not_included' && !o.access?.zone)
    return { ...line, sub: v.zone_not_included.noZone };
  return line;
}

/** The headline and sub of a reason for this outcome. Null when it has none. */
export function verdictLine(
  o: ScanOutcome,
  now: number,
  opts: { desk?: boolean } = {},
): ScanLine | null {
  const line = pick(o, opts.desk === true);
  if (!line) return null;
  const values = lineValues(o, now);
  return { headline: scanLine(line.headline, values), sub: scanLine(line.sub, values) };
}
