/** The verdict line of an outcome, filled from the outcome alone. Pure: every marker has a value. */

import { CHANNEL_LABEL } from '../../../shared/copy/channels.ts';
import {
  SCAN_COPY,
  SCAN_COUNTER_COPY,
  SCAN_REASON_COPY,
  SCAN_REASON_VARIANTS,
  type ScanLine,
  scanLine,
  TYPED_NUMBER_FLAG,
} from '../../../shared/copy/scan.ts';
import { headlineValues } from '../../../shared/copy/scan-headline.ts';
import {
  formatCount,
  formatDay,
  formatMoney,
  formatShortDate,
  formatTime,
  formatWeekday,
} from '../../lib/format.ts';
import { accessValues, agoText } from './access-view.ts';
import { groupHeadline, groupSub, groupView } from './group-view.ts';
import type { ScanOutcome } from './types.ts';

type Values = Record<string, string | number>;
type Value = NonNullable<ScanOutcome['value']>;

/** A value as staff read it: money with its currency, a count with separators, text as is. */
function shown(value: Value, n: unknown): string {
  if (typeof n === 'number')
    return value.format === 'currency' ? formatMoney(n, value.currency ?? null) : formatCount(n);
  if (typeof n === 'string') return n;
  return n === null || n === undefined ? '' : JSON.stringify(n);
}

/** A date as a sub says it: no year inside the current one, no time of day. */
export function subDate(at: number | null | undefined, now: number): string {
  if (!at) return 'Never';
  return new Date(at).getFullYear() === new Date(now).getFullYear()
    ? formatShortDate(at)
    : formatDay(at);
}

/** The channel as staff say it: a paper copy is a printed ticket. */
const channelName = (channel: ScanOutcome['channel']): string =>
  !channel ? 'This copy' : channel === 'paper' ? 'Printed ticket' : CHANNEL_LABEL[channel];

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
        ? formatWeekday(o.at)
        : o.event
          ? formatWeekday(o.event.startsAt)
          : o.at
            ? formatWeekday(o.at)
            : '',
    date: subDate(o.at, now),
    time: o.at ? formatTime(o.at, o.admit?.timeZone) : '',
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
    channel: channelName(o.channel),
    type: o.admit?.type ?? '',
    plan: 'This plan',
    zone: 'this area',
    when: '',
    ...accessValues(o, now),
  };
}

/** The reason's copy, or the variant for a reason whose outcome lacks what the main line names. */
function pick(o: ScanOutcome, desk: boolean, short: boolean): ScanLine | null {
  const reason = o.reason;
  if (!reason) return null;
  const line = SCAN_REASON_COPY[reason];
  const v = SCAN_REASON_VARIANTS;
  const counter = o.value?.counter ? SCAN_COUNTER_COPY[reason] : undefined;
  if (counter) return counter;
  if (reason === 'check_required' && o.flags[0] === TYPED_NUMBER_FLAG)
    return { ...line, sub: v.check_required.typedNumber };
  if (reason === 'needs_approval' && desk) return v.needs_approval;
  if (reason === 'already_done' && !o.previous) return { ...line, sub: v.already_done.noPrevious };
  // The glance card's note carries the instruction; the sub says when and where.
  if (reason === 'already_done' && short) return { ...line, sub: v.already_done.short };
  if (reason === 'wrong_event' && !o.event) return { ...line, sub: v.wrong_event.noEvent };
  if (reason === 'not_yet_valid' && !o.at && !o.event)
    return { ...line, sub: v.not_yet_valid.noWhen };
  if (reason === 'ended' && !o.event)
    return { headline: o.admit ? v.ended.named : v.ended.noPlace, sub: line.sub };
  if ((reason === 'guest_expired' || reason === 'guest_visits_used') && o.admit)
    return { ...line, headline: v[reason].named };
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
  opts: { desk?: boolean; group?: boolean; short?: boolean } = {},
): ScanLine | null {
  // A handheld names the group on an ok card: who is in, and after Check in more, how many it added.
  const group = opts.group && o.kind === 'ok' ? groupView(o) : null;
  if (group)
    return {
      headline: group.done ? groupHeadline(group) : SCAN_COPY.verdict.checkedIn,
      sub: groupSub(group),
    };
  const line = pick(o, opts.desk === true, opts.short === true);
  if (!line) return null;
  const values = lineValues(o, now);
  return { headline: scanLine(line.headline, values), sub: scanLine(line.sub, values) };
}
