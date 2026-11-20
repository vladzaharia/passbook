import type { AccessDay, WeeklyHours } from '../../types.ts';

export const DAYS: readonly AccessDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MINUTE = 60_000;
const DAY_MINUTES = 1440;
const SPAN = /^([01]\d|2[0-3]):([0-5]\d)-(([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

/** Minutes from midnight. `end` passes 1440 for a span that runs past midnight. */
export interface Span {
  start: number;
  end: number;
}

/** `HH:MM-HH:MM`. An end at or before the start runs past midnight; `24:00` only as an end; start = end is bad. */
export function parseSpan(text: unknown): Span | null {
  if (typeof text !== 'string') return null;
  const m = SPAN.exec(text);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = m[3] === '24:00' ? DAY_MINUTES : Number(m[4]) * 60 + Number(m[5]);
  if (end === start) return null;
  return { start, end: end < start ? end + DAY_MINUTES : end };
}

export interface Wall {
  y: number;
  m: number;
  d: number;
  /** 0 = Monday. */
  dow: number;
  /** Minutes since local midnight. */
  min: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(t: number, timeZone: string): number[] {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(t))) out[p.type] = Number(p.value);
  return [
    out.year ?? 0,
    out.month ?? 1,
    out.day ?? 1,
    out.hour ?? 0,
    out.minute ?? 0,
    out.second ?? 0,
  ];
}

const dowOf = (y: number, m: number, d: number) =>
  (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;

/** The local calendar parts of an instant, from `Intl` alone. */
export function wall(t: number, timeZone: string): Wall {
  const [y = 0, m = 1, d = 1, h = 0, mi = 0] = parts(t, timeZone);
  return { y, m, d, dow: dowOf(y, m, d), min: h * 60 + mi };
}

/** Local time minus UTC, in ms, at an instant. */
export function offsetAt(t: number, timeZone: string): number {
  const [y = 0, m = 1, d = 1, h = 0, mi = 0, s = 0] = parts(t, timeZone);
  return Date.UTC(y, m - 1, d, h, mi, s) - Math.floor(t / 1000) * 1000;
}

/** Add days to a calendar date (month and day overflow roll over). */
function addDays(y: number, m: number, d: number, days: number): [number, number, number] {
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

/** The first instant at or after `from` where the offset is `target`, within (from, to]. */
function transitionBetween(from: number, to: number, target: number, timeZone: string): number {
  let lo = from;
  let hi = to;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / MINUTE / 2) * MINUTE;
    if (offsetAt(mid, timeZone) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The instant of a local wall time. A time inside a spring gap is the instant the gap ends;
 * a repeated autumn time is its earlier instant. `minutes` may be 1440 (the next midnight).
 */
export function instantOf(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  minutes: number,
): number {
  const local = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  const before = offsetAt(local - 36 * 3_600_000, timeZone);
  const after = offsetAt(local + 36 * 3_600_000, timeZone);
  const valid: number[] = [];
  for (const off of new Set([before, after])) {
    const t = local - off;
    if (offsetAt(t, timeZone) === off) valid.push(t);
  }
  if (valid.length > 0) return Math.min(...valid);
  // Gap: `local - after` is before the change, `local - before` after it.
  return transitionBetween(
    Math.min(local - before, local - after),
    Math.max(local - before, local - after),
    after,
    timeZone,
  );
}

/** Local midnight that starts the calendar day `days` after the day containing `t`. */
export function endOfDay(t: number, timeZone: string, days = 1): number {
  const w = wall(t, timeZone);
  const [y, m, d] = addDays(w.y, w.m, w.d, days);
  return instantOf(timeZone, y, m, d, 0);
}

/** Weekly hours plus dated exceptions: `YYYY-MM-DD` replaces that day's spans; none is closed all day. */
export type DatedHours = WeeklyHours & { dates?: Record<string, string[]> | undefined };

export const dateKey = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function spansOf(hours: DatedHours, y: number, m: number, d: number): Span[] {
  const out: Span[] = [];
  const day = DAYS[dowOf(y, m, d)] ?? 'mon';
  for (const text of hours.dates?.[dateKey(y, m, d)] ?? hours[day] ?? []) {
    const span = parseSpan(text);
    if (span) out.push(span);
  }
  return out;
}

/** Open at an instant by the local wall clock: start inclusive, end exclusive, overnight spills into the next day. */
export function isOpen(hours: DatedHours | undefined, timeZone: string, t: number): boolean {
  if (hours === undefined) return true;
  const w = wall(t, timeZone);
  for (const s of spansOf(hours, w.y, w.m, w.d))
    if (w.min >= s.start && w.min < Math.min(s.end, DAY_MINUTES)) return true;
  for (const s of spansOf(hours, ...addDays(w.y, w.m, w.d, -1)))
    if (s.end > DAY_MINUTES && w.min < s.end - DAY_MINUTES) return true;
  return false;
}

/** Instants where `hours` may change state: span edges (every reading of an ambiguous time) and offset changes. */
function edges(hours: DatedHours, timeZone: string, from: number, days: number): number[] {
  const w = wall(from, timeZone);
  const out: number[] = [];
  let prev = Math.floor(from / MINUTE) * MINUTE;
  for (let i = -1; i <= days; i++) {
    const [y, m, d] = addDays(w.y, w.m, w.d, i);
    for (const s of spansOf(hours, y, m, d))
      for (const minutes of [s.start, s.end]) out.push(...readings(timeZone, y, m, d, minutes));
    const mid = instantOf(timeZone, ...addDays(y, m, d, 1), 0);
    const offA = offsetAt(prev, timeZone);
    if (offsetAt(mid, timeZone) !== offA)
      out.push(transitionBetween(prev, mid, offsetAt(mid, timeZone), timeZone));
    prev = mid;
  }
  return out;
}

function readings(timeZone: string, y: number, m: number, d: number, minutes: number): number[] {
  const local = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  const found: number[] = [instantOf(timeZone, y, m, d, minutes)];
  for (const off of [
    offsetAt(local - 36 * 3_600_000, timeZone),
    offsetAt(local + 36 * 3_600_000, timeZone),
  ]) {
    const t = local - off;
    if (offsetAt(t, timeZone) === off) found.push(t);
  }
  return found;
}

/** The open state of the intersection of several schedules. */
export function openAll(list: (DatedHours | undefined)[], timeZone: string, t: number): boolean {
  return list.every((h) => isOpen(h, timeZone, t));
}

/**
 * The next instant after `now` where the intersection of `list` flips from its state at `now`,
 * within `days` calendar days; null when it doesn't.
 */
export function nextFlip(
  list: (DatedHours | undefined)[],
  timeZone: string,
  now: number,
  days = 8,
): number | null {
  const state = openAll(list, timeZone, now);
  const all: number[] = [];
  for (const h of list) if (h !== undefined) all.push(...edges(h, timeZone, now, days));
  const sorted = [...new Set(all)].filter((t) => t > now).sort((a, b) => a - b);
  for (const t of sorted) if (openAll(list, timeZone, t) !== state) return t;
  return null;
}

/** When a closed schedule opens next (7 days ahead); null for none. Open already: `now`. */
export function nextOpen(
  list: (DatedHours | undefined)[],
  timeZone: string,
  now: number,
): number | null {
  if (openAll(list, timeZone, now)) return now;
  return nextFlip(list, timeZone, now, 7);
}

/** When an open schedule next closes; null when it stays open through the horizon. */
export function closesAt(
  list: (DatedHours | undefined)[],
  timeZone: string,
  now: number,
): number | null {
  if (!openAll(list, timeZone, now)) return null;
  return nextFlip(list, timeZone, now, 8);
}
