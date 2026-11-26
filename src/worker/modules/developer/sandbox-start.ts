import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { principalOf } from '../../platform/idempotency.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDto } from '../operations/dto.ts';
import { runInRequest } from '../operations/jobs.ts';
import { progressOf } from '../operations/progress.ts';
import type { Progress } from '../operations/progress-types.ts';
import { rowById } from '../operations/repo.ts';
import { operationIdFor, startOperation } from '../operations/start.ts';

export type SandboxKind =
  | 'sandbox.create'
  | 'sandbox.delete'
  | 'sandbox.reset'
  | 'sandbox.recreate';

interface Spec {
  kind: SandboxKind;
  /** The sandbox's org: the operation's target. For a new sandbox, the id it will be made with. */
  orgId: string;
  /** The `Idempotency-Key` header: a repeat answers the first operation and starts nothing. */
  idempotencyKey: string | undefined;
  /** A delete is its Workflow's: that instance, and no lease or backstop job. */
  workflowInstanceId?: string;
  work: (op: OperationDto, progress: Progress) => Promise<void>;
}

/**
 * Starts a sandbox operation and runs its first part in this request's `waitUntil`: the answer is the queued
 * operation, and the page follows it. A kind with a lease also queues a delayed `operation.run` that resumes the
 * work if the request dies. One active operation per person: a second start answers 409 naming the first.
 */
export async function startSandboxOp(
  ctx: ServiceContext,
  auth: SessionAuth,
  spec: Spec,
): Promise<OperationDto> {
  const id = spec.idempotencyKey
    ? await operationIdFor(principalOf(auth), spec.kind, spec.idempotencyKey)
    : undefined;
  const known = id ? await rowById(ctx.env.DB, id) : null;
  if (known) return toDto(known);
  const op = await startOperation(ctx, {
    ...(id ? { id } : {}),
    kind: spec.kind,
    target: { type: 'sandbox', id: spec.orgId },
    actor: { type: 'user', id: auth.userId },
    session: auth.sessionId,
    subject: { userId: auth.userId },
    ...(spec.workflowInstanceId
      ? { workflowInstanceId: spec.workflowInstanceId }
      : { lease: true as const }),
  });
  const run = () => spec.work(op, progressOf(ctx, op.id, op.attempt));
  if (spec.workflowInstanceId)
    ctx.waitUntil(run().catch((error) => progressOf(ctx, op.id, op.attempt).fail(error)));
  else await runInRequest(ctx, op.id, op.attempt, run);
  return op;
}
