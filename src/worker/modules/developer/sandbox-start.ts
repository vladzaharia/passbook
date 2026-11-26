import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { principalOf } from '../../platform/idempotency.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDto } from '../operations/dto.ts';
import { runInRequest } from '../operations/jobs.ts';
import { progressOf } from '../operations/progress.ts';
import type { Progress } from '../operations/progress-types.ts';
import { rowById } from '../operations/repo.ts';
import { operationIdFor, startOperationOnce } from '../operations/start.ts';

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
  /** A delete is its Workflow's: its first instance is named for the operation, and there is no lease or backstop job. */
  workflow?: true;
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
    : ctx.ids.id();
  const known = await rowById(ctx.env.DB, id);
  if (known) return toDto(known);
  const { operation: op, created } = await startOperationOnce(ctx, {
    id,
    kind: spec.kind,
    target: { type: 'sandbox', id: spec.orgId },
    actor: { type: 'user', id: auth.userId },
    session: auth.sessionId,
    subject: { userId: auth.userId },
    // Named for the operation and attempt: the day's sweep can never hold the same name.
    ...(spec.workflow ? { workflowInstanceId: `${id}-r1` } : { lease: true as const }),
  });
  // Two starts with one key race to insert: only the one that inserted runs the work.
  if (!created) return op;
  const run = () => spec.work(op, progressOf(ctx, op.id, op.attempt));
  if (spec.workflow)
    ctx.waitUntil(run().catch((error) => progressOf(ctx, op.id, op.attempt).fail(error)));
  else await runInRequest(ctx, op.id, op.attempt, run);
  return op;
}

/** The operation an earlier start with this `Idempotency-Key` made, for a replay answered before any check. */
export async function replayOf(
  ctx: ServiceContext,
  auth: SessionAuth,
  kinds: readonly SandboxKind[],
  key: string | undefined,
): Promise<OperationDto | null> {
  if (!key) return null;
  for (const kind of kinds) {
    const row = await rowById(ctx.env.DB, await operationIdFor(principalOf(auth), kind, key));
    if (row) return toDto(row);
  }
  return null;
}
