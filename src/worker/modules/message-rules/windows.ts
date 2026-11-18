import type { RuleAnchor, RuleOffset } from '../../../shared/contracts/message-rules.ts';
import {
  addDays,
  dayRange,
  isLeapYear,
  localDate,
  monthDay,
  yearOf,
  zonedInstant,
} from '../../../shared/zoned.ts';

export const HOUR_GRACE_MS = 30 * 60_000;
export const HOUR_CHECK_MS = 10 * 60_000;
export const DAY_RECHECK_MS = 3 * 3_600_000;
/** Day rules stop at this local time; the day then ends unsent. */
export const SEND_DAY_END = '21:00';

export interface RuleTiming {
  anchor: RuleAnchor;
  offset: RuleOffset;
  yearly: boolean;
  sendAt: string;
  timeZone: string;
}

/**
 * The passes a run targets, as absolute values. `occurrence` is what makes a fire unique: the
 * anchor value as stored, the last scan's time, or a year.
 * `[fromMs, toMs)` is half-open for days and
 * `[fromMs, toMs]` for hours (`inclusiveEnd`).
 */
export type RuleWindow =
  | { kind: 'date'; input: string; date: string; occurrence: 'anchor' }
  | {
      kind: 'dateTime';
      input: string;
      fromMs: number;
      toMs: number;
      inclusiveEnd: boolean;
      occurrence: 'anchor';
    }
  | { kind: 'yearly'; input: string; monthDays: string[]; occurrence: `y${number}` }
  | { kind: 'lastScan'; fromMs: number; toMs: number; occurrence: 'lastScan' };

/** What the anchor input holds: `date` is `YYYY-MM-DD`, `date-time` an ISO instant. */
export type AnchorInputKind = 'date' | 'date-time';

const dayShift = (offset: RuleOffset) =>
  offset.when === 'before' ? offset.amount : -offset.amount;

/**
 * The window a run at `now` targets. Day units use the rule zone's calendar; hour units use
 * real hours. Throws on a combination the contract refuses.
 */
export function ruleWindow(rule: RuleTiming, kind: AnchorInputKind, now: number): RuleWindow {
  const { anchor, offset, timeZone } = rule;
  if (anchor.kind === 'lastScan') {
    const [fromMs, toMs] = dayRange(addDays(localDate(now, timeZone), -offset.amount), timeZone);
    return { kind: 'lastScan', fromMs, toMs, occurrence: 'lastScan' };
  }
  const input = anchor.input;
  if (offset.unit === 'hour') {
    const shift = offset.amount * 3_600_000 * (offset.when === 'before' ? 1 : -1);
    return {
      kind: 'dateTime',
      input,
      fromMs: now + shift - HOUR_GRACE_MS,
      toMs: now + shift,
      inclusiveEnd: true,
      occurrence: 'anchor',
    };
  }
  const day = addDays(localDate(now, timeZone), dayShift(offset));
  if (rule.yearly) {
    const monthDays = [monthDay(day)];
    // A 29 Feb anchor fires on 28 Feb in common years.
    if (monthDay(day) === '02-28' && !isLeapYear(yearOf(day))) monthDays.push('02-29');
    return { kind: 'yearly', input, monthDays, occurrence: `y${yearOf(day)}` };
  }
  if (kind === 'date') return { kind: 'date', input, date: day, occurrence: 'anchor' };
  const [fromMs, toMs] = dayRange(day, timeZone);
  return { kind: 'dateTime', input, fromMs, toMs, inclusiveEnd: false, occurrence: 'anchor' };
}

/** True from 08:00-style open until the day's end (21:00 local): the only time day rules send. */
export function sendDayOpen(rule: Pick<RuleTiming, 'sendAt' | 'timeZone'>, now: number): boolean {
  const today = localDate(now, rule.timeZone);
  return (
    now >= zonedInstant(today, rule.sendAt, rule.timeZone) &&
    now < zonedInstant(today, SEND_DAY_END, rule.timeZone)
  );
}

/**
 * When to look at a rule next. Hours: every 10 min. Days: `sendAt` today if still ahead; inside the
 * send day every 3 h until 21:00 local for passes skipped by a budget; then tomorrow's `sendAt`.
 */
export function nextCheckAt(
  rule: Pick<RuleTiming, 'offset' | 'sendAt' | 'timeZone'>,
  now: number,
): number {
  if (rule.offset.unit === 'hour') return now + HOUR_CHECK_MS;
  const today = localDate(now, rule.timeZone);
  const send = zonedInstant(today, rule.sendAt, rule.timeZone);
  if (now < send) return send;
  const retry = now + DAY_RECHECK_MS;
  if (retry < zonedInstant(today, SEND_DAY_END, rule.timeZone)) return retry;
  return zonedInstant(addDays(today, 1), rule.sendAt, rule.timeZone);
}
