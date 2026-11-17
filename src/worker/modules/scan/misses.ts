import type { Grant } from '../../platform/authority.ts';
import { bumpIfStmt } from '../../platform/counters.ts';
import type { SqlValue } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import {
  cappedMissAuditStmt,
  crossedCap,
  missCounterKey,
  missIncrementPart,
  type ReadMissFence,
  readMissAuthorityPredicate,
  requireMissAuditStmt,
  requireMissIncrementStmt,
  requireReadMissObservationStmt,
} from './repo-miss-authority.ts';

export { isReadMissStale } from './repo-miss-authority.ts';

const WINDOW_MS = 10 * 60_000;
export const MISSES_PER_WINDOW = 30;

export type MissResult = 'not_committed' | 'counted' | 'capped';

type MissBatchResult = { results: readonly unknown[] } & ({ success: true } | { success: false });

export interface MissPlan {
  stmts: D1PreparedStatement[];
  result(results: readonly MissBatchResult[]): MissResult;
  throwIfCapped(result: MissResult): void;
}

type Predicate = { sql: string; params: readonly SqlValue[] };

/** `counted`, `capped` or `not_committed` from the increment's returned row. */
function missResultOf(row: unknown): MissResult {
  const count = row && typeof row === 'object' && 'count' in row ? row.count : undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return 'not_committed';
  return count > MISSES_PER_WINDOW ? 'capped' : 'counted';
}

function throwCapped(result: MissResult, window: number, now: number): void {
  if (result !== 'capped') return;
  throw new AppError('SCAN_TOO_MANY_MISSES', 429, 'Too many codes not found. Wait a few minutes.', {
    headers: { 'retry-after': String(Math.ceil((window + WINDOW_MS - now) / 1000)) },
  });
}

function missPlan(
  ctx: ServiceContext,
  actor: ScanActor,
  authority: Predicate,
  now = ctx.clock.now(),
  assertions: readonly D1PreparedStatement[] = [],
): MissPlan {
  const db = ctx.env.DB;
  const window = now - (now % WINDOW_MS);
  const key = missCounterKey(actor);
  const threshold = MISSES_PER_WINDOW + 1;
  const increment = bumpIfStmt(db, key, window, authority);
  const audit = cappedMissAuditStmt(db, {
    actor,
    key,
    window,
    threshold,
    at: now,
    requestId: ctx.requestId,
  });
  const eligible = authority;
  return {
    stmts: [
      ...assertions,
      increment,
      requireMissIncrementStmt(db, eligible),
      audit,
      requireMissAuditStmt(db, eligible, key, window, threshold),
    ],
    result(results) {
      if (
        results.length !== assertions.length + 4 ||
        results.some((item) => !item || item.success === false)
      )
        return 'not_committed';
      return missResultOf(results[assertions.length]?.results?.[0]);
    },
    throwIfCapped: (result) => throwCapped(result, window, now),
  };
}

/**
 * The miss of a finalized `not_found` stop, counted in the stop's own grant: call right after the
 * statement that closes the scan. The increment applies only if that statement changed its row
 * (`changes()`), so a claim counts once; the audit row follows the increment that crossed the cap.
 */
export function grantMiss(g: Grant, ctx: ServiceContext, actor: ScanActor, now: number) {
  const window = now - (now % WINDOW_MS);
  const key = missCounterKey(actor);
  const threshold = MISSES_PER_WINDOW + 1;
  const [increment] = g.include(missIncrementPart(key, window));
  if (!increment) throw new Error('The miss counter was not added.');
  g.audit(
    {
      at: now,
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.misses_capped',
      targetType: actor.scanner ? 'scanner' : null,
      targetId: actor.scanner?.id ?? null,
      requestId: ctx.requestId,
      ipPrefix: null,
      detail: null,
    },
    [crossedCap(key, window, threshold)],
  );
  return {
    /** From the grant's writes: nothing counted (the scan did not close here), counted, or past the cap. */
    result(writes: readonly D1Result[]): MissResult {
      return missResultOf(writes[g.indexOf(increment)]?.results?.[0]);
    },
    throwIfCapped: (result: MissResult) => throwCapped(result, window, now),
  };
}

/**
 * Append this plan to the final actor/item batch. `candidates` must detect changes to
 * the original candidate observation and any matching pending transfer; passless resolve
 * must treat any matching pass as stale. `visible` uses that batch's final item predicates,
 * or is empty only for an established empty projection.
 * Pass just this plan's result slice to `result`.
 */
export function prepareReadMiss(
  ctx: ServiceContext,
  actor: ScanActor,
  fence: ReadMissFence,
): MissPlan {
  const now = ctx.clock.now();
  const observations = Array.isArray(fence?.assertions)
    ? fence.assertions
        .filter((item) => item && typeof item.sql === 'string' && Array.isArray(item.params))
        .map((item) => requireReadMissObservationStmt(ctx.env.DB, item))
    : [];
  return missPlan(ctx, actor, readMissAuthorityPredicate(actor, now, fence), now, observations);
}
