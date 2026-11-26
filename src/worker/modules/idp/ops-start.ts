import type { Context } from 'hono';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { type Actor, platformActorOf } from '../../platform/actor.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ConflictError, UnauthenticatedError, UnavailableError } from '../../platform/errors.ts';
import { principalOf } from '../../platform/idempotency.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { toDto } from '../operations/dto.ts';
import { sendOperationRun } from '../operations/jobs.ts';
import { rowById } from '../operations/repo.ts';
import { operationIdFor, startOperationOnce } from '../operations/start.ts';
import { requireUser } from '../users/service.ts';
import { idpConfigured } from './client.ts';
import { desiredState } from './desired.ts';
import { IDP_UNAVAILABLE_MESSAGE } from './errors.ts';
import { restoreTarget } from './ops-runs.ts';
import { latchedAt } from './repo-scim.ts';
import { statesOfUser } from './repo-state.ts';
import { BREAKER_KEY, BREAKER_LATCH_MS } from './scim-effects.ts';
import type { WritableRole } from './types.ts';

/** Who starts an operation: the actor, and the principal an idempotency key is scoped to. */
export interface Caller {
  actor: Actor;
  principal: string;
}

export function callerOf(c: Context<AppBindings>): Caller {
  const auth = c.var.auth;
  if (!auth) throw new UnauthenticatedError();
  const actor = platformActorOf(c);
  return { actor, principal: principalOf(auth) };
}

type Spec = {
  kind: 'idp.check' | 'idp.dry_run' | 'idp.restore' | 'idp.breaker_clear' | 'idp.offboard';
  target?: { type: string; id: string };
  subject?: Record<string, string>;
  idempotencyKey: string | undefined;
  /** The audit row for the start: who did it, to what. */
  audit: { action: string; targetType: string; targetId: string };
};

/**
 * The operation an earlier start with this key made, answered before any state check: a replay after the hold
 * or latch is gone still gets its operation. The key is the caller's for one target: another one is a 409.
 */
async function replayOf(
  ctx: ServiceContext,
  id: string,
  kind: Spec['kind'],
  target: Spec['target'],
): Promise<OperationDto | null> {
  const row = await rowById(ctx.env.DB, id);
  if (!row) return null;
  const op = toDto(row);
  if (
    op.kind !== kind ||
    (target && (op.target?.type !== target.type || op.target.id !== target.id))
  )
    throw new ConflictError('This key was used for a different request.', 'IDEMPOTENCY_KEY_REUSED');
  return op;
}

/** A replay answered before any state check. */
export async function replay(
  ctx: ServiceContext,
  caller: Caller,
  kind: Spec['kind'],
  key: string | undefined,
  target?: Spec['target'],
): Promise<OperationDto | null> {
  return key
    ? replayOf(ctx, await operationIdFor(caller.principal, kind, key), kind, target)
    : null;
}

/**
 * Starts a Polaris ID operation, queued; `operation.run` does the work. A repeat with the same key answers the
 * first operation; a second start while one is active answers 409 naming it. Platform admins only (the route).
 */
export async function startIdpOp(
  ctx: ServiceContext,
  { actor, principal }: Caller,
  spec: Spec,
): Promise<OperationDto> {
  const id = spec.idempotencyKey
    ? await operationIdFor(principal, spec.kind, spec.idempotencyKey)
    : ctx.ids.id();
  const known = await replayOf(ctx, id, spec.kind, spec.target);
  if (known) return known;
  const { operation, created } = await startOperationOnce(ctx, {
    id,
    kind: spec.kind,
    actor: { type: actor.actorType, id: actor.actorId },
    ...(spec.target ? { target: spec.target } : {}),
    ...(spec.subject ? { subject: spec.subject } : {}),
  });
  if (!created) return operation;
  await recordAudit(ctx, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: spec.audit.action,
    targetType: spec.audit.targetType,
    targetId: spec.audit.targetId,
    detail: { operationId: operation.id },
  });
  await sendOperationRun(ctx, operation.id, operation.attempt);
  return operation;
}

export const limited = (ctx: ServiceContext, { actor }: Caller) =>
  enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:idp-ops:${actor.actorId}`);

export function needBinding(ctx: ServiceContext): void {
  if (!idpConfigured(ctx.env))
    throw new UnavailableError(IDP_UNAVAILABLE_MESSAGE, 'IDP_UNAVAILABLE');
}

/** Check now, or a dry run (`dryRun`): one reconcile of every group. */
export async function startCheck(
  ctx: ServiceContext,
  caller: Caller,
  dryRun: boolean,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  const kind = dryRun ? 'idp.dry_run' : 'idp.check';
  const again = await replay(ctx, caller, kind, idempotencyKey);
  if (again) return again;
  needBinding(ctx);
  await limited(ctx, caller);
  return startIdpOp(ctx, caller, {
    kind: dryRun ? 'idp.dry_run' : 'idp.check',
    idempotencyKey,
    audit: { action: dryRun ? 'idp.dry_run' : 'idp.check', targetType: 'idp', targetId: 'sync' },
  });
}

/** Restore a role the owner paused in Polaris ID. 409 when it is not paused. */
export async function startRestore(
  ctx: ServiceContext,
  caller: Caller,
  userId: string,
  role: WritableRole,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  const target = restoreTarget(userId, role);
  const again = await replay(ctx, caller, 'idp.restore', idempotencyKey, target);
  if (again) return again;
  needBinding(ctx);
  await requireUser(ctx, userId);
  const heldRow = (await statesOfUser(ctx.env.DB, userId)).find(
    (s) => s.target === role && s.held_at,
  );
  if (!heldRow) throw new ConflictError('This role is not paused.', 'IDP_NOT_HELD');
  // The pause is the owner's "no": it stays for a user who is off or a role nothing wants.
  if (!(await desiredState(ctx.env.DB, heldRow.subject, ctx.clock.now())).targets.has(role))
    throw new ConflictError('Nothing wants this role now.', 'IDP_NOT_WANTED');
  await limited(ctx, caller);
  return startIdpOp(ctx, caller, {
    kind: 'idp.restore',
    target,
    subject: { userId, role },
    idempotencyKey,
    audit: { action: 'idp.restore', targetType: 'user', targetId: userId },
  });
}

/** Clear the SCIM breaker. 409 when it is not tripped. */
export async function startBreakerClear(
  ctx: ServiceContext,
  caller: Caller,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  const again = await replay(ctx, caller, 'idp.breaker_clear', idempotencyKey);
  if (again) return again;
  const trippedAt = await latchedAt(ctx.env.DB, BREAKER_KEY, ctx.clock.now(), BREAKER_LATCH_MS);
  if (trippedAt === null)
    throw new ConflictError('The SCIM breaker is not tripped.', 'IDP_BREAKER_CLOSED');
  await limited(ctx, caller);
  return startIdpOp(ctx, caller, {
    kind: 'idp.breaker_clear',
    // The trip the admin saw: the run clears that one, never a later one.
    target: { type: 'scim_breaker', id: String(trippedAt) },
    idempotencyKey,
    audit: { action: 'idp.breaker_clear', targetType: 'idp', targetId: 'scim_breaker' },
  });
}
