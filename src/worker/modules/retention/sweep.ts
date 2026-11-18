// The daily delete of one retention class under the plan: the platform cutoff for orgs on the default, then
// a bounded number of orgs with their own. Every delete commits in one batch with the receipt that records it.

import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { retentionPlan } from './plan.ts';
import { DAY, excludedFromPlatformPass, nextBatch } from './policy.ts';
import { prepareReceipt, recordHead } from './receipt-service.ts';
import {
  CHUNK,
  type Cutoffs,
  deleteChunkStmt,
  FAILED_MAIL_DAYS,
  type Scope,
  type SweepClass,
  selectChunk,
} from './repo-sweep.ts';

const PLATFORM_CHUNKS = 20;
const ORG_CHUNKS = 3;

interface Target {
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

/** One chunk: the receipt row first, then the delete gated on it. Returns the rows chosen, or 0 when none. */
async function sweepChunk(
  ctx: ServiceContext,
  cls: SweepClass,
  t: Target,
  cutoffs: Cutoffs,
): Promise<number> {
  const ids = await selectChunk(ctx.env.DB, cls, t.scope, cutoffs);
  if (ids.length === 0) return 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prepared = await prepareReceipt(ctx, {
      orgId: t.orgId,
      cls,
      kind: 'sweep',
      policyDays: t.days,
      cutoffAt: cutoffs.cutoff,
      deleted: ids.length,
    });
    const [receipt] = await ctx.env.DB.batch([
      prepared.stmt,
      deleteChunkStmt(ctx.env.DB, cls, ids, prepared.receipt.id),
    ]);
    // A lost race on the chain head inserts nothing, and the delete behind it did not run: reread and retry.
    if (receipt?.meta.changes === 1) {
      await recordHead(ctx, prepared.receipt);
      return ids.length;
    }
  }
  throw new ConflictError('Retention receipt chain is busy.', 'RETENTION_RECEIPT_BUSY');
}

async function sweepTarget(ctx: ServiceContext, cls: SweepClass, t: Target): Promise<number> {
  const cutoffs = cutoffsFor(cls, ctx.clock.now(), t.days);
  let total = 0;
  for (let i = 0; i < t.maxChunks; i++) {
    const n = await sweepChunk(ctx, cls, t, cutoffs);
    total += n;
    if (n < CHUNK) break;
  }
  return total;
}

/**
 * Deletes what `cls` allows today. A blocked class (invalid platform value) deletes nothing. Orgs with
 * their own value are taken from a rotating cursor, 25 a day: an org not reached waits a day, late and never early.
 */
export async function sweepClass(
  ctx: ServiceContext,
  cls: SweepClass,
): Promise<{ platform: number; orgs: number }> {
  const plan = await retentionPlan(ctx, cls);
  if (plan.blocked) return { platform: 0, orgs: 0 };
  const platform = await sweepTarget(ctx, cls, {
    scope: { kind: 'platform', exclude: excludedFromPlatformPass(plan) },
    orgId: null,
    days: plan.platformDays,
    maxChunks: PLATFORM_CHUNKS,
  });
  const key = `retention.cursor:${cls}`;
  const stored = await readSystemValue(ctx.env.DB, key);
  const { batch, cursor } = nextBatch(plan.special, typeof stored === 'string' ? stored : null);
  let orgs = 0;
  for (const o of batch)
    orgs += await sweepTarget(ctx, cls, {
      scope: { kind: 'org', orgId: o.orgId },
      orgId: o.orgId,
      days: o.days,
      maxChunks: ORG_CHUNKS,
    });
  await writeSystemValue(ctx.env.DB, key, cursor, ctx.clock.now());
  return { platform, orgs };
}
