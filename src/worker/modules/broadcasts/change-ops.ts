import type { PatchOp } from '../../../shared/contracts/broadcasts-change.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { type InputField, isDateField } from '../../../shared/issuing/fields.ts';

type Values = Readonly<Record<string, Json | undefined>>;

const DURATION = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Moves a date or date-time by an ISO duration, in UTC. A month end clamps (Jan 31 + P1M = Feb 28). */
export function shiftDate(value: string, duration: string): string | null {
  const m = DURATION.exec(duration);
  const at = Date.parse(DAY_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  if (!m || !Number.isFinite(at)) return null;
  const sign = m[1] ? -1 : 1;
  const [years, months, weeks, days] = [m[2], m[3], m[4], m[5]].map((v) => Number(v ?? 0) * sign);
  const d = new Date(at);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCFullYear(d.getUTCFullYear() + (years ?? 0), d.getUTCMonth() + (months ?? 0));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  const moved = new Date(d.getTime() + ((weeks ?? 0) * 7 + (days ?? 0)) * DAY_MS);
  return DAY_ONLY.test(value) ? moved.toISOString().slice(0, 10) : moved.toISOString();
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
export function resolveOps(ops: Readonly<Record<string, PatchOp>>, current: Values): OpResult {
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
      const moved = typeof cur === 'string' ? shiftDate(cur, op.shift) : null;
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
  return text
    .replace(/%/g, '%%')
    .replace(TOKEN, (_, label: string) => (valueFor(label.trim()) ?? '').replace(/%/g, '%%'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
