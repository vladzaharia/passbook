import { AppError, ConflictError, ForbiddenError } from '../../platform/errors.ts';
import { progressOf } from '../operations/progress.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import {
  actorHolds,
  exportRow,
  isOrgAdmin,
  type LifecycleActor,
  lifecycleRow,
  requeueExport,
} from './repo.ts';
import { requireExportAccess } from './service.ts';

/** The retry's own checks are the start's: a person, an org admin or a platform admin, holding it now. */
const authorizeRetry: NonNullable<OperationRunner['authorizeRetry']> = async (ctx, op, caller) => {
  const orgId = op.orgId;
  if (caller.kind !== 'session' || !orgId) throw new ForbiddenError();
  const by: LifecycleActor = {
    kind: caller.roles.includes('admin') ? 'platform' : 'owner',
    userId: caller.userId,
    sessionId: caller.sessionId,
  };
  const org = await lifecycleRow(ctx.env.DB, orgId);
  if (!org || org.purged_at !== null) throw new ForbiddenError();
  await requireExportAccess(ctx, orgId, by);
  if (by.kind === 'owner' && !(await isOrgAdmin(ctx.env.DB, orgId, by.userId)))
    throw new ForbiddenError();
  if (org.purge_started_at !== null)
    throw new ConflictError('This organization is being removed.', 'ORG_PURGING');
  if (!(await actorHolds(ctx.env.DB, by, orgId, ctx.clock.now()))) throw new ForbiddenError();
};

/** A new instance `<exportId>-r<attempt>` over the same export, which goes back to queued. */
const relaunch: NonNullable<OperationRunner['relaunch']> = async (ctx, op) => {
  const exportId = op.target?.id;
  if (!op.orgId || !exportId)
    throw new AppError('ORG_EXPORT_START', 500, 'The export did not start.');
  // The archive is already done (the operation only lost its end): settle it as it is.
  if ((await exportRow(ctx.env.DB, op.orgId, exportId))?.state === 'ready') {
    await progressOf(ctx, op.id, op.attempt).succeed({ href: null, ids: { exportId } });
    return undefined;
  }
  if (!(await requeueExport(ctx.env.DB, op.orgId, exportId)))
    throw new ConflictError('Another export is running.', 'ORG_EXPORT_RUNNING');
  const instanceId = `${exportId}-r${op.attempt}`;
  await ctx.env.ORG_EXPORT.create({
    id: instanceId,
    params: { orgId: op.orgId, exportId, operationId: op.id, attempt: op.attempt },
  });
  return { workflowInstanceId: instanceId };
};

export const operationRunners: OperationRunners = {
  'org.export': {
    authorizeRetry,
    relaunch,
    workflow: async (ctx, instanceId) => ctx.env.ORG_EXPORT.get(instanceId),
  },
};
