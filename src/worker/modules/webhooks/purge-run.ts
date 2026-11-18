import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { healHead } from '../retention/head-store.ts';
import { DAY } from '../retention/policy.ts';
import { prepareReceipt, recordHead } from '../retention/receipt-service.ts';
import { chainHead } from '../retention/repo-receipts.ts';
import type { Scope } from '../retention/repo-sweep.ts';
import {
  CHUNK,
  deleteChunkStmt,
  type PurgeKind,
  receiptGate,
  selectChunk,
} from './repo-retention.ts';

/** Chunks one run deletes: the platform pass, then all org passes together. The rest waits for the next run. */
export const PURGE_LIMITS = { platformChunks: 30, orgChunks: 30 };

export interface Budget {
  chunks: number;
}

/** The days each kind keeps. The 7-day delivered and test-send rules are fixed exceptions under the class value. */
export function daysOf(d: { webhooks: number; events: number }): Record<PurgeKind, number> {
  return {
    feed: Math.min(d.webhooks, d.events),
    delivered: Math.min(7, d.webhooks),
    attempts: d.webhooks,
    testAttempts: Math.min(7, d.webhooks),
  };
}

/** One chunk: its receipt and its delete commit in one batch, so a failed receipt undoes the delete. */
async function chunk(
  ctx: ServiceContext,
  orgId: string | null,
  scope: Scope,
  kind: PurgeKind,
  days: number,
): Promise<number> {
  const cutoff = ctx.clock.now() - days * DAY;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ids = await selectChunk(ctx.env.DB, kind, scope, cutoff);
    if (ids.length === 0) return 0;
    const prepared = await prepareReceipt(
      ctx,
      {
        orgId,
        cls: 'webhooks',
        kind: 'sweep',
        policyDays: days,
        cutoffAt: cutoff,
        deleted: ids.length,
      },
      receiptGate(kind, scope, cutoff, ids),
    );
    const [receipt] = await ctx.env.DB.batch([
      prepared.stmt,
      deleteChunkStmt(ctx.env.DB, kind, scope, cutoff, ids, prepared.receipt.id),
    ]);
    if (receipt?.meta.changes === 1) {
      await recordHead(ctx, prepared.receipt);
      return ids.length;
    }
  }
  throw new ConflictError('Retention receipt chain is busy.', 'RETENTION_RECEIPT_BUSY');
}

/** Purges one scope under `days` until nothing is left or the budget runs out. Returns rows removed per kind. */
export async function purgeScope(
  ctx: ServiceContext,
  orgId: string | null,
  scope: Scope,
  days: Record<PurgeKind, number>,
  budget: Budget,
): Promise<Record<PurgeKind, number>> {
  const out: Record<PurgeKind, number> = { feed: 0, delivered: 0, attempts: 0, testAttempts: 0 };
  await healHead(ctx, orgId, 'webhooks', await chainHead(ctx.env.DB, orgId, 'webhooks'));
  for (const kind of ['feed', 'delivered', 'attempts', 'testAttempts'] as const) {
    while (budget.chunks > 0) {
      budget.chunks--;
      const n = await chunk(ctx, orgId, scope, kind, days[kind]);
      out[kind] += n;
      if (n < CHUNK) break;
    }
  }
  return out;
}
