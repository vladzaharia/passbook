import type { OperationDto, OperationStep } from '../../../shared/contracts/operations.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { principalOf } from '../../platform/idempotency.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { requireOrgCapability } from '../orgs/access.ts';
import { parseSteps, toDto } from './dto.ts';
import { sendOperationRun } from './jobs.ts';
import { progressOf } from './progress.ts';
import { kindOf, runnerOf } from './registry.ts';
import { activeByDedupe, type OperationRow, rowById } from './repo.ts';
import { finish, markCancel, resetForRetry, setWorkflowInstance } from './repo-write.ts';
import { readable } from './service.ts';
import { KEEP_MS } from './start.ts';

function auditActor(auth: AuthContext) {
  if (auth.kind === 'session') return { actorType: 'user', actorId: auth.userId } as const;
  if (auth.kind === 'api_key') return { actorType: 'api_key', actorId: auth.keyId } as const;
  return { actorType: 'system', actorId: null } as const;
}

/** The active row was started by this caller. */
const same = (row: OperationRow, auth: AuthContext) => {
  const a = auditActor(auth);
  return row.actor_type === a.actorType && row.actor_id === a.actorId;
};

const notCancelable = () =>
  new AppError('OPERATION_NOT_CANCELABLE', 409, 'This cannot be stopped. Wait for it to finish.');
const notRetryable = () => new AppError('OPERATION_NOT_RETRYABLE', 409, 'This cannot be retried.');

/**
 * Stops it. Every write is one guarded UPDATE: a queued stop only takes a row still `queued`, a running stop
 * only a kind whose policy allows it and only the attempt we read. Nothing changed means no audit row and no
 * hook: the caller gets the operation as it is, or 409.
 */
export async function cancelOperation(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
): Promise<OperationDto> {
  const { row } = await readable(ctx, auth, id, 'write');
  const dto = toDto(row);
  const policy = kindOf(row.kind)?.cancel ?? 'never';
  if (policy === 'never') throw notCancelable();
  const now = ctx.clock.now();
  let changed = false;
  if (row.status === 'queued')
    changed = await finish(ctx.env.DB, {
      id,
      attempt: row.attempt,
      now,
      status: 'cancelled',
      steps: JSON.stringify(
        dto.steps.map(
          (s): OperationStep => (s.state === 'pending' ? { ...s, state: 'skipped' } : s),
        ),
      ),
      stepKey: row.step_key,
      error: null,
      result: null,
      expiresAt: row.audience === 'starter' ? null : now + KEEP_MS.ended,
      onlyQueued: true,
    });
  // The runner may have claimed the row since we read it: a stop of a running row is for kinds that allow it.
  if (!changed && (policy === 'between-steps' || policy === 'items'))
    changed = (await markCancel(ctx.env.DB, id, row.attempt, now)).changes === 1;
  const fresh = toDto((await rowById(ctx.env.DB, id)) ?? row);
  if (!changed) {
    if (fresh.cancelRequested || fresh.status === 'cancelled') return fresh;
    throw notCancelable();
  }
  await runnerOf(row.kind)?.cancel?.(ctx, fresh);
  await recordAudit(ctx, {
    orgId: row.org_id,
    ...auditActor(auth),
    action: 'operation.cancelled',
    targetType: 'operation',
    targetId: id,
    detail: { kind: row.kind },
  });
  return fresh;
}

/** Steps that are done stay done; the failed step goes back to pending. */
function stepsForRetry(steps: OperationStep[]): OperationStep[] {
  return steps.map((s) =>
    s.state === 'failed'
      ? {
          ...s,
          state: 'pending',
          startedAt: null,
          finishedAt: null,
          detail: null,
          until: null,
          waitingReason: null,
        }
      : s,
  );
}

/**
 * Retries a failed operation under the same id with the next attempt. The kind's `authorizeRetry` reruns the
 * start's checks (authority, entitlements, rate limit) BEFORE the row is touched, so a refused retry burns no
 * attempt and a retry is never an authorization shortcut. A repeat with the same `Idempotency-Key`, including
 * the loser of two concurrent ones, answers the operation the first retried.
 */
export async function retryOperation(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
  idempotencyKey?: string,
): Promise<OperationDto> {
  const { row } = await readable(ctx, auth, id, 'write');
  // The key is kept as a hash on the row, per principal.
  const retryKey =
    idempotencyKey === undefined ? null : await sha256Hex(`${principalOf(auth)}:${idempotencyKey}`);
  if (retryKey !== null && row.retry_key === retryKey) return toDto(row);
  const def = kindOf(row.kind);
  const runner = runnerOf(row.kind);
  if (
    row.status !== 'failed' ||
    row.error_retryable !== 1 ||
    !def?.retry ||
    !runner?.authorizeRetry
  )
    throw notRetryable();
  await runner.authorizeRetry(ctx, toDto(row), auth);
  const now = ctx.clock.now();
  let reset: boolean;
  try {
    reset = await resetForRetry(ctx.env.DB, {
      id,
      attempt: row.attempt,
      now,
      steps: JSON.stringify(stepsForRetry(parseSteps(row.steps))),
      stepKey: null,
      retryKey,
      // The retrying session takes the row over: a step-up revoked the one that started it.
      actorSession:
        row.audience === 'starter' && auth.kind === 'session' ? auth.sessionId : row.actor_session,
      expiresAt: row.audience === 'starter' ? now + KEEP_MS.starter : null,
    });
  } catch (error) {
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
    const active = row.dedupe_key ? await activeByDedupe(ctx.env.DB, row.dedupe_key) : null;
    throw new AppError(
      'OPERATION_RUNNING',
      409,
      'This is already running.',
      active && same(active, auth) ? { operationId: active.id } : {},
    );
  }
  if (!reset) {
    // Lost a race: the same key answers the winner's retry, anything else is not retryable now.
    const now2 = await rowById(ctx.env.DB, id);
    if (now2 && retryKey !== null && now2.retry_key === retryKey) return toDto(now2);
    throw notRetryable();
  }
  const next = row.attempt + 1;
  const fresh = toDto((await rowById(ctx.env.DB, id)) as OperationRow);
  try {
    const launched = runner.relaunch
      ? await runner.relaunch(ctx, fresh, { instanceId: row.workflow_instance_id }, auth)
      : undefined;
    if (!runner.relaunch) await sendOperationRun(ctx, id, next);
    if (launched?.workflowInstanceId)
      await setWorkflowInstance(ctx.env.DB, id, next, launched.workflowInstanceId);
  } catch (error) {
    // The refused retry leaves the earlier purge named on the row, so the next retry still sees it.
    if (row.workflow_instance_id)
      await setWorkflowInstance(ctx.env.DB, id, next, row.workflow_instance_id);
    await progressOf(ctx, id, next).fail(error);
    throw error;
  }
  await recordAudit(ctx, {
    orgId: row.org_id,
    ...auditActor(auth),
    action: 'operation.retried',
    targetType: 'operation',
    targetId: id,
    detail: { kind: row.kind, attempt: next },
  });
  return toDto((await rowById(ctx.env.DB, id)) as OperationRow);
}

/**
 * Whether this caller could stop or retry the operation at all, for the route's step-up: a person who could
 * not (unknown id, no membership, another user's starter row) is told 404 or 403, never asked to sign in again,
 * so the prompt reveals nothing. The mode is not part of the question; the write itself checks it.
 */
export async function mayAct(ctx: ServiceContext, auth: AuthContext, id: string): Promise<boolean> {
  if (auth.kind !== 'session') return false;
  const row = await rowById(ctx.env.DB, id);
  const def = row ? kindOf(row.kind) : undefined;
  if (!row || !def?.stepUp) return false;
  if (row.audience === 'starter') return row.actor_id === auth.userId;
  if (row.audience === 'platform') return auth.roles.includes('admin');
  if (!row.org_id || !def.write) return false;
  try {
    await requireOrgCapability(ctx, auth.userId, row.org_id, def.write);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}
