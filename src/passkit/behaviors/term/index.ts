import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { BehaviorPlugin, JsonSchemaObject, TemplateManifest } from '../../types.ts';
import {
  addDays,
  addMonths,
  daysInMonth,
  instantOf,
  isRealDate,
  isTimeZone,
  localOf,
} from './calendar.ts';

export type TermUnit = 'days' | 'months' | 'years' | 'month-end';
/** Where the start comes from: set by hand, stamped at the first successful scan, or stamped once at issue. */
export type TermStartOn = 'input' | 'first-scan' | 'issue';

export interface TermConfig {
  /**
   * Input holding the start: `YYYY-MM-DD` (a local date in `timeZone`) or an ISO 8601 date-time.
   * A `first-scan` or `issue` start is stamped into it once, only while it is empty.
   */
  start: string;
  startOn?: TermStartOn;
  /**
   * Input holding the date whose day of the month the term keeps. A renewal that continues from
   * the end sets it, so a 31st start keeps landing on month end instead of drifting to the 28th.
   * Empty: the start's own day.
   */
  anchor?: string;
  /**
   * The term. `months` and `years` are calendar months from the start day (31 Jan + 1 month is the
   * last day of February). `month-end` ends at the close of the start's month, then `length - 1`
   * more months. One term is at most ten years.
   */
  unit: TermUnit;
  length: number;
  /** IANA zone the calendar and the end-of-day are read in. Default UTC. */
  timeZone?: string;
  /** End at 23:59:59 local on the last day instead of at the start's time of day. Always on for `month-end`. */
  endOfDay?: boolean;
  /** Calendar days the pass stays valid past the term. */
  graceDays?: number;
  /** Set `voided` when the end is already past. */
  voidWhenPast?: boolean;
}

const configSchema: JsonSchemaObject = {
  type: 'object',
  required: ['start', 'unit', 'length'],
  additionalProperties: false,
  properties: {
    start: { type: 'string', minLength: 1 },
    startOn: { enum: ['input', 'first-scan', 'issue'] },
    anchor: { type: 'string', minLength: 1 },
    unit: { enum: ['days', 'months', 'years', 'month-end'] },
    length: { type: 'integer', minimum: 1, maximum: 3650 },
    timeZone: { type: 'string', minLength: 1 },
    endOfDay: { type: 'boolean' },
    graceDays: { type: 'integer', minimum: 0, maximum: 365 },
    voidWhenPast: { type: 'boolean' },
  },
};

const MAX_MONTHS = 120;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The input a term waits on for the scanner (`first-scan`) or the publish (`issue`) to stamp. */
/** The first `term` behavior's config, or null for a template without a term. */
export function termConfigOf(manifest: Pick<TemplateManifest, 'behaviors'>): TermConfig | null {
  const use = (manifest.behaviors ?? []).find((b) => b.use === 'term');
  return use ? (use.config as unknown as TermConfig) : null;
}

export function stampInput(
  manifest: Pick<TemplateManifest, 'behaviors'>,
  on: 'first-scan' | 'issue',
): string | null {
  for (const use of manifest.behaviors ?? []) {
    const config = use.config as Partial<TermConfig> | undefined;
    if (use.use === 'term' && config?.startOn === on && config.start) return config.start;
  }
  return null;
}

/** A start or anchor value as an instant; throws on a date that does not exist. */
export function parseTermDate(raw: string, key: string, tz: string): number {
  const parts = DATE_PART.exec(raw);
  if (parts && !isRealDate(Number(parts[1]), Number(parts[2]), Number(parts[3])))
    throw new Error(`${key} is not a date.`);
  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return instantOf({ y: Number(y), mo: Number(mo), d: Number(d), h: 0, mi: 0, s: 0 }, tz);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || new Date(ms).getUTCFullYear() < 1970)
    throw new Error(`${key} is not a date.`);
  return ms;
}

/** The end of one term as an instant, grace included. `anchorMs` supplies the day of the month. */
export function termEnd(startMs: number, config: TermConfig, anchorMs?: number): number {
  const tz = config.timeZone ?? DEFAULT_TIME_ZONE;
  const start = localOf(startMs, tz);
  const base = anchorMs === undefined ? start : { ...start, d: localOf(anchorMs, tz).d };
  let local = start;
  if (config.unit === 'days') {
    local = addDays(start, config.length);
  } else {
    const months = config.unit === 'years' ? config.length * 12 : config.length;
    if (months > MAX_MONTHS) throw new Error('The term is over ten years.');
    if (config.unit === 'month-end') {
      local = addMonths({ ...start, d: 1 }, months - 1);
      local = { ...local, d: daysInMonth(local.y, local.mo) };
    } else {
      local = addMonths(base, months);
    }
  }
  if (config.endOfDay === true || config.unit === 'month-end')
    local = { ...local, h: 23, mi: 59, s: 59 };
  return instantOf(addDays(local, config.graceDays ?? 0), tz);
}

/**
 * The start and anchor to write on a renewal. Renewed on or before the end, the next term runs
 * on from the current end and keeps the original day of the month (`anchorMs`, else the start's).
 * Renewed after the end, it starts at the renewal and takes its day: a late renewal never starts
 * in the past. A day-end boundary starts the next term at the following midnight.
 */
export function renewedStart(
  startMs: number,
  config: Omit<TermConfig, 'graceDays'>,
  renewedAtMs: number,
  anchorMs?: number,
): { start: number; anchor: number } {
  const end = termEnd(startMs, config, anchorMs);
  const next = config.endOfDay === true || config.unit === 'month-end' ? end + 1000 : end;
  if (renewedAtMs > next) return { start: renewedAtMs, anchor: renewedAtMs };
  return { start: next, anchor: anchorMs ?? startMs };
}

/**
 * Sets `expirationDate` from a start and a term, in calendar units. The scanner reads the same
 * field, so validity follows the term. A `first-scan` term has no end until the scan stamps its
 * start input; any other empty start leaves the pass as it is.
 */
export const term: BehaviorPlugin<TermConfig> = {
  id: 'term',
  version: 1,
  configSchema,
  apply(pass, input, config, ctx) {
    const tz = config.timeZone ?? ctx.timeZone ?? DEFAULT_TIME_ZONE;
    if (config.timeZone !== undefined && !isTimeZone(config.timeZone)) {
      throw new Error(`${config.timeZone} is not a time zone.`);
    }
    const raw = input[config.start];
    if (typeof raw !== 'string' || raw === '') {
      if (config.startOn === 'first-scan') delete pass.expirationDate;
      return;
    }
    const anchorRaw = config.anchor ? input[config.anchor] : undefined;
    const anchor =
      typeof anchorRaw === 'string' && anchorRaw !== ''
        ? parseTermDate(anchorRaw, config.anchor ?? '', tz)
        : undefined;
    const end = termEnd(parseTermDate(raw, config.start, tz), { ...config, timeZone: tz }, anchor);
    pass.expirationDate = iso(end);
    if (config.voidWhenPast && end <= ctx.now.getTime()) pass.voided = true;
  },
};

export default term;
