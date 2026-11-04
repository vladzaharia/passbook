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
 * Minute cron hook: the one path that rebuilds passes whose source changed. An org whose branding
 * went quiet, and a template whose active version changed (deploy, upload, activation, sync), each
 * get one bulk reissue of their live passes, however many changes came before.
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
 * Live passes on an older version of an active template move to the active one. Each active
 * version is queued once: passes that cannot take it stay where they are, are logged per pass
 * (`bulk_reissue.pass_failed`) and show as blocked on the template.
 */
export async function reissueStaleTemplates(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const due = await quietUnqueuedTemplates(db, ctx.clock.now() - STALE_QUIET_MS, PER_RUN);
  for (const template of due) {
    if (!(await claimTemplateReissue(db, template))) continue;
    try {
      const stale = await countStalePasses(db, template.id, template.version);
      if (stale === 0) continue;
      const instanceId = await startBulkReissue(ctx, system, {
        templateId: template.id,
        version: template.version,
        ...(template.orgId ? { orgId: template.orgId } : {}),
        cause: 'template_upgrade',
      });
      ctx.log.info('template.reissue_started', { templateId: template.id, stale, instanceId });
    } catch (error) {
      // A template that cannot be resolved will not resolve next minute either: keep the mark.
      const permanent = error instanceof AppError && error.status < 500;
      if (!permanent) await releaseTemplateReissue(db, template);
      ctx.log.error('template.reissue_failed', {
        templateId: template.id,
        code: 'TEMPLATE_REISSUE',
        error,
      });
    }
  }
}
