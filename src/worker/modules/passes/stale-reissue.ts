import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { claimBrandingDirty, markBrandingDirty, quietDirtyOrgs } from '../orgs/repo-branding.ts';
import {
  claimTemplateReissue,
  countStalePasses,
  quietUnqueuedTemplates,
  releaseTemplateReissue,
} from '../templates/repo-stale.ts';
import { startBulkReissue } from './bulk.ts';

/** Changes this close together share one reissue. */
export const STALE_QUIET_MS = 60_000;
export const BRANDING_QUIET_MS = STALE_QUIET_MS;
const PER_RUN = 20;

const system = { type: 'system', id: null } as const;

/**
 * Minute cron hook: quiet branding changes and newly approved template releases each get a bulk
 * reissue. Template releases are claimed separately for each effective organization and mode.
 */
export async function reissueStalePasses(ctx: ServiceContext): Promise<void> {
  await reissueStaleBranding(ctx);
  await reissueStaleTemplates(ctx);
}

export async function reissueStaleBranding(ctx: ServiceContext): Promise<void> {
  const due = await quietDirtyOrgs(ctx.env.DB, ctx.clock.now() - STALE_QUIET_MS, PER_RUN);
  for (const { id: orgId, at } of due) {
    if (!(await claimBrandingDirty(ctx.env.DB, orgId, at))) continue;
    try {
      const instanceId = await startBulkReissue(ctx, system, { orgId, cause: 'branding' });
      ctx.log.info('org.branding_reissue_started', { orgId, instanceId });
    } catch (error) {
      // Put the mark back so the next minute retries.
      await markBrandingDirty(ctx.env.DB, orgId, at);
      ctx.log.error('org.branding_reissue_failed', { orgId, code: 'BRANDING_REISSUE', error });
    }
  }
}

/**
 * Live passes on an older, non-equivalent version move to the approved release for their
 * organization and mode. Each release is queued once; passes that cannot take it stay where
 * they are and are logged per pass (`bulk_reissue.pass_failed`).
 */
export async function reissueStaleTemplates(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const due = await quietUnqueuedTemplates(db, ctx.clock.now() - STALE_QUIET_MS, PER_RUN);
  for (const template of due) {
    if (!(await claimTemplateReissue(db, template))) continue;
    try {
      const stale = await countStalePasses(
        db,
        template.id,
        template.version,
        template.orgId,
        template.mode,
      );
      if (stale === 0) continue;
      const instanceId = await startBulkReissue(
        ctx,
        system,
        {
          templateId: template.id,
          version: template.version,
          orgId: template.orgId,
          cause: 'template_upgrade',
        },
        {
          mode: template.mode,
          expectedRelease: { id: template.releaseId, generation: template.generation },
        },
      );
      ctx.log.info('template.reissue_started', {
        templateId: template.id,
        orgId: template.orgId,
        mode: template.mode,
        releaseId: template.releaseId,
        stale,
        instanceId,
      });
    } catch (error) {
      // A superseded claim and transient failures may be retried; permanent template errors stay
      // marked. Releasing is conditional, so it cannot undo a newer release's claim.
      const permanent = error instanceof AppError && error.status < 500;
      if (
        !permanent ||
        (error instanceof AppError &&
          (error.code === 'TEMPLATE_RELEASE_CONFLICT' ||
            error.code === 'TEMPLATE_RELEASE_REQUIRED'))
      )
        await releaseTemplateReissue(db, template);
      ctx.log.error('template.reissue_failed', {
        templateId: template.id,
        orgId: template.orgId,
        mode: template.mode,
        releaseId: template.releaseId,
        code: 'TEMPLATE_REISSUE',
        error,
      });
    }
  }
}
