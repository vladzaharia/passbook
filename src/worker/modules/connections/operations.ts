import { actorOf } from '../../platform/context.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { actorOfAuth } from '../operations/start-org.ts';
import { authorizeStoredConnection } from './access.ts';
import { syncNow } from './actions.ts';
import { requireConnection } from './service.ts';

const connectionOf = (op: { target: { type: string; id: string } | null }) => {
  if (op.target?.type !== 'connection')
    throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
  return op.target.id;
};

/** The retry's own checks are Sync now's: integrations:manage in the org, in the mode it ran in. */
const authorizeRetry: NonNullable<OperationRunner['authorizeRetry']> = async (ctx, op, caller) => {
  if (!op.orgId || caller.kind === 'scanner') throw new ForbiddenError();
  if (caller.mode !== op.mode)
    throw new NotFoundError('Operation not found.', 'OPERATION_NOT_FOUND');
  await authorizeStoredConnection(ctx, caller, op.orgId, 'integrations:manage');
  const conn = await requireConnection(ctx, connectionOf(op));
  if (conn.orgId !== op.orgId) throw new ForbiddenError();
};

/** A sync under an instance of its own (named for the operation and attempt), reporting into the same operation. */
const relaunch: NonNullable<OperationRunner['relaunch']> = async (ctx, op, _previous, caller) => {
  if (!op.orgId || caller.kind === 'scanner') throw new ForbiddenError();
  const id = connectionOf(op);
  const authority = await authorizeStoredConnection(ctx, caller, op.orgId, 'integrations:manage');
  let started = false;
  const run = await syncNow(ctx, actorOf(caller), id, authority, `op:${op.id}:${op.attempt}`, {
    actor: actorOfAuth(caller),
    existing: op,
    onStarted: () => {
      started = true;
    },
  });
  // Joined a run that was already open: it reports to no operation, so this one would wait for nothing.
  if (!started) throw new ConflictError('A sync is already running.', 'CONNECTION_SYNC_RUNNING');
  return { workflowInstanceId: run.workflowInstanceId };
};

export const operationRunners: OperationRunners = {
  'connection.sync': {
    authorizeRetry,
    relaunch,
    workflow: async (ctx, instanceId) => ctx.env.CONNECTION_SYNC.get(instanceId),
  },
};
