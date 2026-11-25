import {
  addDays,
  addMonths,
  instantOf,
  localOf,
} from '../../../passkit/behaviors/term/calendar.ts';
import type { PatchOp } from '../../../shared/contracts/broadcasts-change.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { type InputField, isDateField } from '../../../shared/issuing/fields.ts';
import { CALENDAR_ZONE } from '../../../shared/time-zone.ts';

type Values = Readonly<Record<string, Json | undefined>>;

const DURATION = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET = /([+-])(\d{2}):?(\d{2})$/;
const two = (n: number) => String(n).padStart(2, '0');

/**
 * Moves a date or date-time by an ISO duration. A bare date is a calendar day (UTC math, never
 * shifted). A date-time moves on the org's calendar in `timeZone`, so a month or a day keeps its
 * wall time across a DST change; the result keeps the value's style (Z, an offset, or no offset).
 * A month end clamps (Jan 31 + P1M = Feb 28).
 */
export function shiftDate(value: string, duration: string, timeZone: string): string | null {
  const m = DURATION.exec(duration);
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  const [years, months, weeks, days] = [m[2], m[3], m[4], m[5]].map((v) => Number(v ?? 0) * sign);
  const dayCount = (weeks ?? 0) * 7 + (days ?? 0);
  const monthCount = (years ?? 0) * 12 + (months ?? 0);
  if (DAY_ONLY.test(value)) {
    const at = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(at)) return null;
    const moved = addDays(addMonths(localOf(at, CALENDAR_ZONE), monthCount), dayCount);
    return `${moved.y}-${two(moved.mo)}-${two(moved.d)}`;
  }
  const wall = WALL.exec(value);
  const at = wall
    ? instantOf(
        {
          y: Number(wall[1]),
          mo: Number(wall[2]),
          d: Number(wall[3]),
          h: Number(wall[4]),
          mi: Number(wall[5]),
          s: Number(wall[6] ?? 0),
        },
        timeZone,
      )
    : Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const to = instantOf(addDays(addMonths(localOf(at, timeZone), monthCount), dayCount), timeZone);
  if (wall) {
    const l = localOf(to, timeZone);
    const head = `${l.y}-${two(l.mo)}-${two(l.d)}T${two(l.h)}:${two(l.mi)}`;
    return wall[6] === undefined ? head : `${head}:${two(l.s)}`;
  }
  const off = OFFSET.exec(value);
  if (!off) return new Date(to).toISOString();
  const l = localOf(to, timeZone);
  const minutes = Math.round((Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - to) / 60_000);
  const abs = Math.abs(minutes);
  const head = `${l.y}-${two(l.mo)}-${two(l.d)}T${two(l.h)}:${two(l.mi)}:${two(l.s)}`;
  return `${head}${minutes < 0 ? '-' : '+'}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

const empty = (v: Json | undefined): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export type OpResult =
  | { ok: true; next: Record<string, Json>; from: Record<string, Json>; to: Record<string, Json> }
  | { ok: false; code: 'NO_VALUE' | 'NOT_A_DATE' | 'NOT_A_NUMBER' };

/**
 * The inputs after the ops, plus the touched keys' values before and after (null is empty). A `shift`
 * on an empty value and an `add` on text cannot change that pass: `ok` is false with the reason.
 */
export function resolveOps(
  ops: Readonly<Record<string, PatchOp>>,
  current: Values,
  timeZone: string,
): OpResult {
  const next: Record<string, Json> = {};
  for (const [k, v] of Object.entries(current)) if (v !== undefined) next[k] = v;
  const from: Record<string, Json> = {};
  const to: Record<string, Json> = {};
  for (const [key, op] of Object.entries(ops)) {
    const cur = current[key];
    from[key] = cur ?? null;
    if ('set' in op) next[key] = op.set;
    else if ('clear' in op) delete next[key];
    else if ('shift' in op) {
      if (empty(cur)) return { ok: false, code: 'NO_VALUE' };
      const moved = typeof cur === 'string' ? shiftDate(cur, op.shift, timeZone) : null;
      if (moved === null) return { ok: false, code: 'NOT_A_DATE' };
      next[key] = moved;
    } else {
      if (!empty(cur) && typeof cur !== 'number') return { ok: false, code: 'NOT_A_NUMBER' };
      next[key] = (typeof cur === 'number' ? cur : 0) + op.add;
    }
    to[key] = next[key] ?? null;
  }
  return { ok: true, next, from, to };
}

/** What an op may do to a field, or null when it fits: a shift needs a date, an add a number, a clear an optional field. */
export function opMisfit(field: InputField, op: PatchOp): string | null {
  if ('shift' in op && !isDateField(field)) return `${field.label} is not a date.`;
  if ('add' in op) {
    if (field.type !== 'number' && field.type !== 'integer')
      return `${field.label} is not a number.`;
    if (field.type === 'integer' && !Number.isInteger(op.add))
      return `${field.label} takes a whole number.`;
  }
  if ('clear' in op && field.required) return `${field.label} is required.`;
  return null;
}

/** `{Label}` tokens in a run's text. */
const TOKEN = /\{([^{}]{1,64})\}/g;

export const tokensOf = (text: string): string[] =>
  [...text.matchAll(TOKEN)].map((m) => (m[1] ?? '').trim());

/** The text with each token read from `valueFor` (the field's new value as the form shows it); `%` stays literal for Wallet. */
export function fillTokens(text: string, valueFor: (label: string) => string | null): string {
  const filled = text
    .replace(TOKEN, (_, label: string) => valueFor(label.trim()) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .replace(/%/g, '%%');
  // Wallet wants the format specifier for the field's new value in every change message.
  return `${filled} %@`;
}

const same = (a: Json | undefined, b: Json | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every wanted key holds its value (an absent key reads as null). */
export const atValues = (have: Record<string, Json | undefined>, want: Record<string, Json>) =>
  Object.entries(want).every(([k, v]) => same(have[k], v));
