import type { ServiceContext } from '../../platform/service-context.ts';
import { claimBrandingDirty, markBrandingDirty, quietDirtyOrgs } from '../orgs/repo-branding.ts';
import { startBulkReissue } from './bulk.ts';

/** Saves this close together share one reissue. */
export const BRANDING_QUIET_MS = 60_000;
const ORGS_PER_RUN = 20;

/**
 * Minute cron hook: an org whose branding has been quiet for BRANDING_QUIET_MS gets one bulk
 * reissue of its live passes, however many saves came before.
 */
export async function reissueStaleBranding(ctx: ServiceContext): Promise<void> {
  const due = await quietDirtyOrgs(ctx.env.DB, ctx.clock.now() - BRANDING_QUIET_MS, ORGS_PER_RUN);
  for (const { id: orgId, at } of due) {
    if (!(await claimBrandingDirty(ctx.env.DB, orgId, at))) continue;
    try {
      const instanceId = await startBulkReissue(
        ctx,
        { type: 'system', id: null },
        { orgId, cause: 'branding' },
      );
      ctx.log.info('org.branding_reissue_started', { orgId, instanceId });
    } catch (error) {
      // Put the mark back so the next minute retries.
      await markBrandingDirty(ctx.env.DB, orgId, at);
      ctx.log.error('org.branding_reissue_failed', { orgId, code: 'BRANDING_REISSUE', error });
    }
  }
}
