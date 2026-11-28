import type { ServiceContext } from '../../platform/service-context.ts';
import { ORG_SLICE, orgsDue } from './repo-daily.ts';
import { HORIZON_MS, syncOrgUsage } from './usage-daily.ts';

/** Minute hook `usage.periods`: up to 50 orgs with periods, day bounds or a recount window due. */
export async function usagePeriods(ctx: ServiceContext): Promise<void> {
  for (const orgId of await orgsDue(ctx.env.DB, ctx.clock.now(), HORIZON_MS, ORG_SLICE)) {
    try {
      await syncOrgUsage(ctx, orgId);
    } catch (error) {
      ctx.log.error('usage.periods_failed', { code: 'USAGE_PERIODS', orgId, error });
    }
  }
}
