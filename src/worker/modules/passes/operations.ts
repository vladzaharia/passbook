import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { actorOfAuth } from '../operations/start-org.ts';
import { startBulkReissue } from './bulk.ts';
import { tenantAuthorityOf } from './http.ts';
import { limitKeyReissues } from './key-reissue-limit.ts';

/** The retry's own checks are the start's: passes:operate in the org, in the mode it ran in, and a key's hourly limit. */
const authorizeRetry: NonNullable<OperationRunner['authorizeRetry']> = async (ctx, op, caller) => {
  if (!op.orgId || caller.kind === 'scanner') throw new ForbiddenError();
  if (caller.mode !== op.mode)
    throw new NotFoundError('Operation not found.', 'OPERATION_NOT_FOUND');
  await tenantAuthorityOf(ctx, caller, op.orgId, 'passes:operate');
  if (caller.kind === 'api_key') await limitKeyReissues(ctx, caller.keyId);
};

/** A new run over the same target, reporting into the same operation. The target says what it was for. */
const relaunch: NonNullable<OperationRunner['relaunch']> = async (ctx, op, _previous, caller) => {
  const target = op.target;
  if (!op.orgId || !op.mode || !target || caller.kind === 'scanner') throw new ForbiddenError();
  const authority = await tenantAuthorityOf(ctx, caller, op.orgId, 'passes:operate');
  const instanceId = await startBulkReissue(
    ctx,
    caller.kind === 'session'
      ? { type: 'user', id: caller.userId }
      : { type: 'api_key', id: caller.keyId },
    {
      orgId: op.orgId,
      ...(target.type === 'identity'
        ? { identityId: target.id, cause: 'resign' as const }
        : target.type === 'template'
          ? { templateId: target.id }
          : {}),
    },
    { authority, mode: op.mode, operation: { actor: actorOfAuth(caller), existing: op } },
  );
  return { workflowInstanceId: instanceId };
};

export const operationRunners: OperationRunners = {
  'passes.reissue': {
    authorizeRetry,
    relaunch,
    workflow: async (ctx, instanceId) => ctx.env.BULK_REISSUE.get(instanceId),
  },
};
