import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { deletePass } from '../passes/service.ts';
import { healHead } from '../retention/head-store.ts';
import { type PreparedReceipt, prepareReceipt, recordHead } from '../retention/receipt-service.ts';
import { chainHead } from '../retention/repo-receipts.ts';
import type { Scope } from '../retention/repo-sweep.ts';
import { retentionTargets } from '../retention/targets.ts';
import {
  deleteVisit,
  endedVisits,
  passRemovedBySystem,
  type RetentionVisit,
  visitHeld,
} from './repo-retention.ts';

const DAY = 86_400_000;
const BATCH = 50;
/** Visits one run removes: the platform pass, then all org passes together. A backlog drains over days. */
export const VISIT_LIMITS = { platform: 200, orgs: 200 };

/**
 * Soft-deletes the visit's pass as the system, refused in the write itself when a hold is in force.
 * `gone`: removed now, or by an earlier run that stopped before the visit row went (the audit row says
 * so), so the receipt's count is the same however many runs it took. `held`: leave the visit alone.
 */
async function removePass(
  ctx: ServiceContext,
  v: RetentionVisit,
): Promise<'gone' | 'absent' | 'held'> {
  try {
    await deletePass(ctx, { type: 'system', id: null }, v.pass_id, v.org_id, undefined, {
      unlessHeld: true,
    });
    return 'gone';
  } catch (error) {
    if (error instanceof ConflictError && (await visitHeld(ctx.env.DB, v))) return 'held';
    if (!(error instanceof NotFoundError)) throw error;
    return (await passRemovedBySystem(ctx.env.DB, v)) ? 'gone' : 'absent';
  }
}

/**
 * Daily: visits whose window ended more days ago than the `visitors` retention plan allows (the org's days,
 * floors and holds, else the platform's) are removed with a receipt, in one batch each. An org under a hold
 * keeps its visits. A pass deleted by retention or erasure takes its visit with it (the row cascades).
 */
export async function dailyVisitors(ctx: ServiceContext): Promise<void> {
  const targets = await retentionTargets(ctx, ['visitors']);
  if (!targets) return;
  const now = ctx.clock.now();
  let removed = 0;
  const run = async (
    orgId: string | null,
    days: number,
    scope: Scope,
    budget: { left: number },
  ) => {
    await healHead(ctx, orgId, 'visitors', await chainHead(ctx.env.DB, orgId, 'visitors'));
    let after = '';
    while (budget.left > 0) {
      const limit = Math.min(BATCH, budget.left);
      const page = await endedVisits(ctx.env.DB, now - days * DAY, after, limit, scope);
      for (const v of page) {
        budget.left--;
        try {
          // The visitor pass goes first (its name, host and copies follow pass retention), then the visit row.
          // A hold that lands after the page was read refuses the pass delete itself; the visit stays too.
          const passGone = await removePass(ctx, v);
          if (passGone === 'held') continue;
          const receipt: PreparedReceipt = await prepareReceipt(ctx, {
            orgId,
            cls: 'visitors',
            kind: 'visitor',
            policyDays: days,
            cutoffAt: now - days * DAY,
            deleted: passGone === 'gone' ? 2 : 1,
            anonymised: 0,
          });
          await deleteVisit(ctx, v, receipt);
          await recordHead(ctx, receipt.receipt);
          removed++;
        } catch (error) {
          ctx.log.error('visitor.retention_failed', {
            orgId: v.org_id,
            visitorId: v.id,
            code: 'VISITOR_RETENTION',
            error,
          });
        }
      }
      const last = page[page.length - 1];
      if (page.length < limit || !last) break;
      after = last.id;
    }
  };
  await run(
    null,
    targets.platform.visitors,
    { kind: 'platform', exclude: targets.exclude },
    { left: VISIT_LIMITS.platform },
  );
  const budget = { left: VISIT_LIMITS.orgs };
  let visited = 0;
  for (const o of targets.orgs) {
    if (budget.left <= 0) break;
    try {
      await run(o.orgId, o.days.visitors, { kind: 'org', orgId: o.orgId }, budget);
    } catch (error) {
      ctx.log.error('visitor.retention_org_failed', {
        orgId: o.orgId,
        code: 'VISITOR_RETENTION',
        error,
      });
    }
    visited++;
  }
  await targets.finish(visited);
  if (removed > 0) ctx.log.info('visitor.retention', { removed });
}
