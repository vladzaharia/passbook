import type { ServiceContext } from '../../platform/service-context.ts';
import { exportKey } from './export.ts';
import { expiredExports, failStuckExports, markExpired, purgeDue } from './repo.ts';

const BATCH = 50;
const STUCK_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Daily hook `org_lifecycle.sweep`: removes expired archives, fails exports whose workflow was lost, and
 * starts a purge for every closed org whose window is over and that no hold stands on. One purge instance per
 * org and day, so a repeat of the hook never doubles a run; the purge itself is safe to repeat.
 */
export async function dailyOrgLifecycle(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  for (const row of await expiredExports(ctx.env.DB, now, BATCH)) {
    await ctx.env.BUCKET.delete(exportKey(row.org_id, row.id));
    await markExpired(ctx.env.DB, row.id);
  }
  const stuck = await failStuckExports(ctx.env.DB, now - STUCK_MS, now);
  if (stuck > 0) ctx.log.warn('org.export_stuck', { code: 'ORG_EXPORT_STUCK', count: stuck });
  let started = 0;
  for (const org of await purgeDue(ctx.env.DB, now, BATCH)) {
    try {
      await ctx.env.ORG_PURGE.create({
        id: `org-purge-${org.id}-${day(now)}`,
        params: { orgId: org.id },
      });
      started++;
    } catch (error) {
      // The same day's instance exists, or the binding failed; tomorrow's run tries again.
      ctx.log.warn('org.purge_start_skipped', { orgId: org.id, code: 'ORG_PURGE_START', error });
    }
  }
  if (started > 0) ctx.log.info('org.purge_started', { count: started });
}
