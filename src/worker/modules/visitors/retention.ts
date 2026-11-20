import type { ServiceContext } from '../../platform/service-context.ts';
import { healHead } from '../retention/head-store.ts';
import { type PreparedReceipt, prepareReceipt, recordHead } from '../retention/receipt-service.ts';
import { chainHead } from '../retention/repo-receipts.ts';
import type { Scope } from '../retention/repo-sweep.ts';
import { retentionTargets } from '../retention/targets.ts';
import { deleteVisit, endedVisits } from './repo-retention.ts';

const DAY = 86_400_000;
const BATCH = 50;
/** Visits one run removes: the platform pass, then all org passes together. A backlog drains over days. */
export const VISIT_LIMITS = { platform: 200, orgs: 200 };

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
          const receipt: PreparedReceipt = await prepareReceipt(ctx, {
            orgId,
            cls: 'visitors',
            kind: 'visitor',
            policyDays: days,
            cutoffAt: now - days * DAY,
            deleted: 1,
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
