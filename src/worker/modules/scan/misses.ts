import { bumpIfStmt } from '../../platform/counters.ts';
import type { SqlValue } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import {
  cappedMissAuditStmt,
  completedMissPredicate,
  missCounterKey,
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

function missPlan(
  ctx: ServiceContext,
  actor: ScanActor,
  authority: Predicate,
  completed?: Predicate,
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
  const eligible = completed ?? authority;
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
      const row = results[assertions.length]?.results?.[0];
      const count = row && typeof row === 'object' && 'count' in row ? row.count : undefined;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1)
        return 'not_committed';
      return count > MISSES_PER_WINDOW ? 'capped' : 'counted';
    },
    throwIfCapped(result) {
      if (result !== 'capped') return;
      throw new AppError(
        'SCAN_TOO_MANY_MISSES',
        429,
        'Too many codes not found. Wait a few minutes.',
        {
          headers: { 'retry-after': String(Math.ceil((window + WINDOW_MS - now) / 1000)) },
        },
      );
    },
  };
}

/**
 * Run right after the stop's grant batch committed, as its own batch: the increment applies only to
 * the finalized `not_found` generation, so it counts once. Both completeness sentinels abort this batch.
 */
export function prepareMiss(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  claimAt: number,
): MissPlan {
  const completed = completedMissPredicate({ actor, scanId, claimAt });
  return missPlan(ctx, actor, completed, completed);
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
  return missPlan(
    ctx,
    actor,
    readMissAuthorityPredicate(actor, now, fence),
    undefined,
    now,
    observations,
  );
}

/** Count a confirmed read-only miss without credential input in its own transaction. */
export async function countMiss(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  const csrf = await actorCsrfFence(ctx, actor);
  if (!csrf) return;
  const credentials =
    actor.credentialKeysetCommitment === undefined
      ? null
      : {
          credentialKeysetCommitment: actor.credentialKeysetCommitment,
          credentialTombstoneRefs: [],
        };
  const plan = prepareReadMiss(ctx, actor, {
    csrf,
    credentials,
    candidates: { sql: '0', params: [] },
    visible: [],
  });
  const results = await ctx.env.DB.batch(plan.stmts);
  plan.throwIfCapped(plan.result(results));
}
