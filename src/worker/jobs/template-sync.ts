import { type Grant, jobGrant } from '../platform/authority.ts';
import type { Check } from '../platform/authority-checks.ts';
import { createJobContext, type ServiceContext } from '../platform/service-context.ts';
import { TEMPLATE_SYNC_TABLES } from './template-sync-tables.ts';

/** A refused sync write means another build or an administrator changed what this sync read. */
export const SYNC_CONFLICT = 'TEMPLATE_SYNC_CONFLICT';
const CODES = {
  stale: SYNC_CONFLICT,
  release: SYNC_CONFLICT,
  lineage: SYNC_CONFLICT,
  config: SYNC_CONFLICT,
};

/**
 * The one `system:` grant a request may trigger: baked-template sync (idempotent, first use per isolate).
 * It returns only a grant of the fixed purpose `platform.job.template_sync`; the job context it needs
 * never leaves this function, and `tools/authority-scope.ts` allows only `templates/sync.ts` to import it.
 */
export function templateSyncGrant(ctx: ServiceContext, checks: Check[]): Grant {
  const job: ServiceContext = {
    ...createJobContext(ctx.env, 'template-sync', { clock: ctx.clock, log: ctx.log }),
    ids: ctx.ids,
    requestId: ctx.requestId,
    waitUntil: ctx.waitUntil,
  };
  return jobGrant(job, {
    job: 'template-sync',
    purpose: 'platform.job.template_sync',
    codes: CODES,
    checks,
    tables: TEMPLATE_SYNC_TABLES,
  });
}
