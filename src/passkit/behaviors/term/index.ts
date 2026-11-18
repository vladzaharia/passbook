import type { BehaviorPlugin, JsonSchemaObject } from '../../types.ts';
import { addDays, addMonths, daysInMonth, instantOf, isTimeZone, localOf } from './calendar.ts';

export type TermUnit = 'days' | 'months' | 'years' | 'month-end';

export interface TermConfig {
  /** Input holding the start as ISO 8601. Omit to start at build time. */
  start?: string;
  /**
   * The term. `months` and `years` are calendar months from the start day (31 Jan + 1 month is the
   * last day of February). `month-end` ends at the close of the start's month, then `length - 1`
   * more months.
   */
  unit: TermUnit;
  length: number;
  /** Input holding how many whole terms were renewed. Each extends the end by one term from the current end. */
  renewals?: string;
  /** IANA zone the calendar and the end-of-day are read in. Default UTC. */
  timeZone?: string;
  /** End at 23:59:59 local on the last day instead of at the start's time of day. Always on for `month-end`. */
  endOfDay?: boolean;
  /** Days the pass stays valid past the term. */
  graceDays?: number;
  /** Set `voided` when the end is already past. */
  voidWhenPast?: boolean;
}

const configSchema: JsonSchemaObject = {
  type: 'object',
  required: ['unit', 'length'],
  additionalProperties: false,
  properties: {
    start: { type: 'string', minLength: 1 },
    unit: { enum: ['days', 'months', 'years', 'month-end'] },
    length: { type: 'integer', minimum: 1, maximum: 3650 },
    renewals: { type: 'string', minLength: 1 },
    timeZone: { type: 'string', minLength: 1 },
    endOfDay: { type: 'boolean' },
    graceDays: { type: 'integer', minimum: 0, maximum: 365 },
    voidWhenPast: { type: 'boolean' },
  },
};

const DAY = 86_400_000;
const MAX_RENEWALS = 100;
const MAX_DAYS = 3650;
const MAX_MONTHS = 120;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function renewalCount(raw: unknown, key: string): number {
  if (raw === undefined || raw === '' || raw === null) return 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RENEWALS) throw new Error(`${key} is not a count.`);
  return n;
}

/** The end of a term as an instant. Anchored on the start, so renewals never drift from the start day. */
export function termEnd(startMs: number, config: TermConfig, renewals = 0): number {
  const tz = config.timeZone ?? 'UTC';
  const terms = 1 + renewals;
  const start = localOf(startMs, tz);
  const endOfDay = config.endOfDay === true || config.unit === 'month-end';
  let local = start;
  if (config.unit === 'days') {
    if (config.length * terms > MAX_DAYS) throw new Error('The term is over ten years.');
    local = addDays(start, config.length * terms);
  } else {
    const months = config.unit === 'years' ? config.length * 12 : config.length;
    if (months * terms > MAX_MONTHS) throw new Error('The term is over ten years.');
    if (config.unit === 'month-end') {
      local = addMonths({ ...start, d: 1 }, months * terms - 1);
      local = { ...local, d: daysInMonth(local.y, local.mo) };
    } else {
      local = addMonths(start, months * terms);
    }
  }
  if (endOfDay) local = { ...local, h: 23, mi: 59, s: 59 };
  return instantOf(local, tz);
}

/**
 * Sets `expirationDate` from a start and a term, in calendar units. The scanner reads the same
 * field, so validity follows the term. No start yet (a term that begins at first scan, before the
 * scan has stamped its input) leaves the pass without an end.
 */
export const term: BehaviorPlugin<TermConfig> = {
  id: 'term',
  version: 1,
  configSchema,
  apply(pass, input, config, ctx) {
    if (config.timeZone !== undefined && !isTimeZone(config.timeZone)) {
      throw new Error(`${config.timeZone} is not a time zone.`);
    }
    let startMs = ctx.now.getTime();
    if (config.start !== undefined) {
      const raw = input[config.start];
      if (typeof raw !== 'string' || raw === '') {
        delete pass.expirationDate;
        return;
      }
      startMs = Date.parse(raw);
      if (Number.isNaN(startMs)) throw new Error(`${config.start} is not a date.`);
    }
    const renewals = config.renewals ? renewalCount(input[config.renewals], config.renewals) : 0;
    const end = termEnd(startMs, config, renewals) + (config.graceDays ?? 0) * DAY;
    pass.expirationDate = iso(end);
    if (config.voidWhenPast && end <= ctx.now.getTime()) pass.voided = true;
  },
};

export default term;
