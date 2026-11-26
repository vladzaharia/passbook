import type { Mode } from '../../../shared/contracts/common.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from './progress.ts';
import { type StartInput, startOperationOnce } from './start.ts';

/** Who started it, for the row: a person, a key, or the system (a cron, a queue). */
export function actorOfAuth(auth: AuthContext | undefined): StartInput['actor'] {
  if (auth?.kind === 'session') return { type: 'user', id: auth.userId };
  if (auth?.kind === 'api_key') return { type: 'api_key', id: auth.keyId };
  return { type: 'system', id: null };
}

export interface OrgStart {
  kind: string;
  orgId: string;
  mode: Mode;
  target?: { type: string; id: string };
  subject?: Record<string, string>;
  workflowInstanceId?: string;
}

/**
 * Starts an org operation for a request that already passed its own authority checks (`actorOfAuth` names the caller). Call it after those
 * checks and before the work is queued, so the runner always finds its row. A start whose subject is already
 * running answers 409 OPERATION_RUNNING naming the first.
 */
export async function startOrgOperation(
  ctx: ServiceContext,
  actor: StartInput['actor'],
  spec: OrgStart,
): Promise<OperationDto> {
  const { operation } = await startOperationOnce(ctx, {
    kind: spec.kind,
    org: { orgId: spec.orgId, mode: spec.mode },
    actor,
    ...(spec.target ? { target: spec.target } : {}),
    ...(spec.subject ? { subject: spec.subject } : {}),
    ...(spec.workflowInstanceId ? { workflowInstanceId: spec.workflowInstanceId } : {}),
  });
  return operation;
}

/** The start failed after the row was made: end it, so nothing waits on work that never began. */
export async function failStarted(
  ctx: ServiceContext,
  op: Pick<OperationDto, 'id' | 'attempt'>,
  error: unknown,
): Promise<void> {
  await progressOf(ctx, op.id, op.attempt).fail(error);
}

/** A platform operation (readable by platform admins): no org or mode. The caller already proved it is one. */
export async function startPlatformOperation(
  ctx: ServiceContext,
  actor: StartInput['actor'],
  spec: Pick<OrgStart, 'kind' | 'target' | 'subject' | 'workflowInstanceId'>,
): Promise<OperationDto> {
  const { operation } = await startOperationOnce(ctx, {
    kind: spec.kind,
    actor,
    ...(spec.target ? { target: spec.target } : {}),
    ...(spec.subject ? { subject: spec.subject } : {}),
    ...(spec.workflowInstanceId ? { workflowInstanceId: spec.workflowInstanceId } : {}),
  });
  return operation;
}
