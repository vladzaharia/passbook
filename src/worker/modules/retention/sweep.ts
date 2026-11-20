// The daily delete of one retention class under the plan: the platform cutoff for orgs on the default, then
// a bounded number of orgs with their own. Every delete commits in one batch with the receipt that records it.

import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { healHead } from './head-store.ts';
import { retentionPlan } from './plan.ts';
import { DAY, excludedFromPlatformPass, nextBatch } from './policy.ts';
import { prepareReceipt, recordHead } from './receipt-service.ts';
import { chainHead } from './repo-receipts.ts';
import {
  CHUNK,
  type Cutoffs,
  deleteChunkStmt,
  FAILED_MAIL_DAYS,
  receiptGate,
  type Scope,
  type SweepClass,
  type SweepTable,
  selectChunk,
} from './repo-sweep.ts';

export const SWEEP_LIMITS = { platformChunks: 50, orgChunks: 50, orgBudgetMs: 15_000 };

interface Target {
  table: SweepTable;
  scope: Scope;
  /** Receipt chain: null is the platform pass. */
  orgId: string | null;
  days: number;
  maxChunks: number;
}

function cutoffsFor(cls: SweepClass, now: number, days: number): Cutoffs {
  const cutoff = now - days * DAY;
  // Failed and partial mail is kept for support: at least 90 days, never shorter than the class value.
  return {
    cutoff,
    failedCutoff: cls === 'delivery' ? Math.min(cutoff, now - FAILED_MAIL_DAYS * DAY) : cutoff,
  };
}

/**
 * One chunk: the receipt row first, then the delete, in one batch. The receipt lands only while exactly the
 * chosen rows are still eligible, and the delete only after it, so the receipt counts what was removed. A lost
 * race, a hold or a second run in the window changes the rows: nothing is written and the rows are chosen again.
 * Returns the rows removed, 0 when none.
 */
async function sweepChunk(
  ctx: ServiceContext,
  cls: SweepClass,
  t: Target,
  cutoffs: Cutoffs,
): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ids = await selectChunk(ctx.env.DB, t.table, t.scope, cutoffs);
    if (ids.length === 0) return 0;
    const prepared = await prepareReceipt(
      ctx,
      {
        orgId: t.orgId,
        cls,
        kind: 'sweep',
        policyDays: t.days,
        cutoffAt: cutoffs.cutoff,
        deleted: ids.length,
      },
      receiptGate(t.table, t.scope, cutoffs, ids),
    );
    const [receipt] = await ctx.env.DB.batch([
      prepared.stmt,
      deleteChunkStmt(ctx.env.DB, t.table, t.scope, cutoffs, ids, prepared.receipt.id),
    ]);
    if (receipt?.meta.changes === 1) {
      await recordHead(ctx, prepared.receipt);
      return ids.length;
    }
  }
  throw new ConflictError('Retention receipt chain is busy.', 'RETENTION_RECEIPT_BUSY');
}

/** Returns rows removed and whether the target stopped at its cap with rows left. */
async function sweepTarget(
  ctx: ServiceContext,
  cls: SweepClass,
  t: Target,
): Promise<{ removed: number; capped: boolean }> {
  const cutoffs = cutoffsFor(cls, ctx.clock.now(), t.days);
  await healHead(ctx, t.orgId, cls, await chainHead(ctx.env.DB, t.orgId, cls));
  let removed = 0;
  let capped = false;
  for (let i = 0; i < t.maxChunks; i++) {
    const n = await sweepChunk(ctx, cls, t, cutoffs);
    removed += n;
    if (n < CHUNK) break;
    capped = i === t.maxChunks - 1;
  }
  if (capped)
    ctx.log.warn('retention.backlog', { cls, orgId: t.orgId, removed, code: 'RETENTION_BACKLOG' });
  return { removed, capped };
}

/**
 * Deletes what `cls` allows today. A blocked class (invalid platform value) deletes nothing. Orgs with
 * their own value are taken from a rotating cursor, 25 a day and within a time budget: an org not reached
 * waits for the next visit, late and never early. A target that stops at its cap logs `RETENTION_BACKLOG`.
 */
export async function sweepClass(
  ctx: ServiceContext,
  cls: SweepClass,
  limits = SWEEP_LIMITS,
  /** A table that ages with the class (offline reads with scans): same plan, holds and receipt chain. */
  table: SweepTable = cls,
): Promise<{ platform: number; orgs: number }> {
  const plan = await retentionPlan(ctx, cls);
  if (plan.blocked) return { platform: 0, orgs: 0 };
  const { removed: platform } = await sweepTarget(ctx, cls, {
    table,
    scope: { kind: 'platform', exclude: excludedFromPlatformPass(plan) },
    orgId: null,
    days: plan.platformDays,
    maxChunks: limits.platformChunks,
  });
  const key = `retention.cursor:${table}`;
  const stored = await readSystemValue(ctx.env.DB, key);
  const next = nextBatch(plan.special, typeof stored === 'string' ? stored : null);
  const started = performance.now();
  let orgs = 0;
  let visited = 0;
  for (const o of next.batch) {
    if (visited > 0 && performance.now() - started > limits.orgBudgetMs) {
      ctx.log.warn('retention.backlog', {
        cls,
        code: 'RETENTION_BACKLOG',
        budget: true,
        left: next.batch.length - visited,
      });
      break;
    }
    orgs += (
      await sweepTarget(ctx, cls, {
        table,
        scope: { kind: 'org', orgId: o.orgId },
        orgId: o.orgId,
        days: o.days,
        maxChunks: limits.orgChunks,
      })
    ).removed;
    visited++;
  }
  const cursor =
    visited === next.batch.length ? next.cursor : (next.batch[visited - 1]?.orgId ?? null);
  await writeSystemValue(ctx.env.DB, key, cursor, ctx.clock.now());
  return { platform, orgs };
}
