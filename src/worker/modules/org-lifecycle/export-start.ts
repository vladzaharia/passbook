import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { OrgExportSchema } from '../../../shared/contracts/org-lifecycle.ts';
import { ORG_LIFECYCLE_COPY as COPY } from '../../../shared/copy/org-lifecycle.ts';
import type { Actor } from '../../platform/context.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { launchExport } from './export-operation.ts';
import {
  exportRow,
  exportRows,
  insertExport,
  isOrgAdmin,
  type LifecycleActor,
  lifecycleRow,
} from './repo.ts';
import { exportDto, notFound, requireExportAccess } from './service.ts';

type ExportDto = z.infer<typeof OrgExportSchema>;

/**
 * Starts an archive of everything the org holds. One at a time per org; the row lands only while the caller's
 * session and role still hold. The workflow runs under the export's id, so a repeat start is a no-op.
 */
export async function requestExport(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  by: LifecycleActor,
  mode: Mode = 'live',
): Promise<ExportDto & { operationId: string | null }> {
  const org = await lifecycleRow(ctx.env.DB, orgId);
  if (!org || org.purged_at !== null) throw notFound();
  await requireExportAccess(ctx, orgId, by);
  if (by.kind === 'owner' && !(await isOrgAdmin(ctx.env.DB, orgId, by.userId)))
    throw new ForbiddenError();
  if (org.purge_started_at !== null) throw new ConflictError(COPY.purging, 'ORG_PURGING');
  const id = ctx.ids.id();
  if (!(await insertExport(ctx.env.DB, { id, orgId, now: ctx.clock.now() }, by))) {
    const open = (await exportRows(ctx.env.DB, orgId)).some(
      (e) => e.state === 'queued' || e.state === 'running',
    );
    if (open) throw new ConflictError('An export is already running.', 'ORG_EXPORT_RUNNING');
    throw new ForbiddenError();
  }
  const operationId = await launchExport(ctx, { orgId, exportId: id, userId: by.userId, mode });
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.export',
    targetType: 'org',
    targetId: orgId,
    detail: { exportId: id, by: by.kind },
  });
  const row = await exportRow(ctx.env.DB, orgId, id);
  if (!row) throw notFound();
  return { ...exportDto(row), operationId };
}
