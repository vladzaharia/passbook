import type { Json } from '../../../shared/contracts/common.ts';
import { getPointer } from '../lib/pointer.ts';
import type { ListConfig } from './config.ts';

type Incremental = NonNullable<ListConfig['incremental']>;

/** A record's updated time in ms, or undefined when the field is absent or unreadable. */
export function updatedAt(record: Json, inc: Incremental): number | undefined {
  const raw = getPointer(record, inc.field);
  if (inc.format === 'iso') {
    const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  return inc.format === 'unix' ? n * 1000 : n;
}

/**
 * The highest updated time on a page, folded into `m` and never past the clock: a time in the future
 * (skew, a scheduled-at field) would otherwise push the next `since` ahead and hide every later change.
 */
export function highest(
  items: readonly Json[],
  inc: Incremental,
  m: number | undefined,
  now: number,
): number | undefined {
  let top = m;
  for (const item of items) {
    const at = updatedAt(item, inc);
    if (at === undefined) continue;
    const t = Math.min(at, now);
    if (top === undefined || t > top) top = t;
  }
  return top;
}

/** The `since` value for the request, `overlapSeconds` before the high-water mark. */
export function sinceParam(inc: Incremental, h: number | undefined): string | undefined {
  if (h === undefined) return undefined;
  const ms = Math.max(0, h - inc.overlapSeconds * 1000);
  if (inc.format === 'unix') return String(Math.floor(ms / 1000));
  if (inc.format === 'unix-ms') return String(ms);
  return new Date(ms).toISOString();
}

export function maxOf(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}
