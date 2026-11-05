/** Display conditions (DM 3.2): paths, numeric and calendar-day comparisons in the actor's zone. */
import type { Json } from '../../types.ts';
import { dayIndex, toInstant, toNumber } from './format.ts';
import type { ScanCond } from './schema.ts';
import { type EvalCtx, isEmptyValue, resolve } from './text.ts';

const MAX_DEPTH = 8;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function compare(value: number, ops: { gt?: number; gte?: number; lt?: number; lte?: number }) {
  if (ops.gt !== undefined && !(value > ops.gt)) return false;
  if (ops.gte !== undefined && !(value >= ops.gte)) return false;
  if (ops.lt !== undefined && !(value < ops.lt)) return false;
  if (ops.lte !== undefined && !(value <= ops.lte)) return false;
  return true;
}

function leaf(value: Json | undefined, cond: Record<string, unknown>, ctx: EvalCtx): boolean {
  if (cond.eq !== undefined) return value !== undefined && same(value, cond.eq);
  if (Array.isArray(cond.in)) return value !== undefined && cond.in.some((v) => same(v, value));
  if (cond.empty !== undefined) return isEmptyValue(value) === cond.empty;
  const days = cond.daysFromNow as { gt?: number } | undefined;
  if (days) {
    const instant = toInstant(value);
    if (!instant) return false;
    const delta =
      dayIndex(instant.ms, instant.zone ?? ctx.timeZone) - dayIndex(ctx.now, ctx.timeZone);
    return compare(delta, days);
  }
  const n = toNumber(value);
  return n !== null && compare(n, cond as { gt?: number });
}

export function testCond(cond: ScanCond, ctx: EvalCtx, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if ('all' in cond) return cond.all.every((c) => testCond(c, ctx, depth + 1));
  if ('any' in cond) return cond.any.some((c) => testCond(c, ctx, depth + 1));
  if ('not' in cond) return !testCond(cond.not, ctx, depth + 1);
  if ('input' in cond) return leaf(resolve(ctx.scope, `inputs.${cond.input}`), cond, ctx);
  return leaf(resolve(ctx.scope, cond.path), cond, ctx);
}

/** Every binding path a condition reads, `input` sugar included. */
export function condPaths(cond: ScanCond, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  if ('all' in cond) return cond.all.flatMap((c) => condPaths(c, depth + 1));
  if ('any' in cond) return cond.any.flatMap((c) => condPaths(c, depth + 1));
  if ('not' in cond) return condPaths(cond.not, depth + 1);
  return ['input' in cond ? `inputs.${cond.input}` : cond.path];
}

/** Depth (a leaf is 1) and leaf count, for the 4 and 12 limits. */
export function condShape(cond: ScanCond, depth = 1): { depth: number; leaves: number } {
  const children =
    'all' in cond ? cond.all : 'any' in cond ? cond.any : 'not' in cond ? [cond.not] : null;
  if (!children) return { depth, leaves: 1 };
  return children
    .map((c) => condShape(c, depth + 1))
    .reduce((a, b) => ({ depth: Math.max(a.depth, b.depth), leaves: a.leaves + b.leaves }), {
      depth,
      leaves: 0,
    });
}
