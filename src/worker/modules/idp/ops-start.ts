import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, UnavailableError } from '../../platform/errors.ts';
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
import { IDP_UNAVAILABLE_MESSAGE } from './errors.ts';
import { restoreTarget } from './ops-runs.ts';
import { breakerOpen } from './repo-scim.ts';
import { statesOfUser } from './repo-state.ts';
import { BREAKER_KEY, BREAKER_LATCH_MS } from './scim-effects.ts';
import type { WritableRole } from './types.ts';

type Spec = {
  kind: 'idp.check' | 'idp.dry_run' | 'idp.restore' | 'idp.breaker_clear';
  target?: { type: string; id: string };
  subject?: Record<string, string>;
  idempotencyKey: string | undefined;
  /** The audit row for the start: who did it, to what. */
  audit: { action: string; targetType: string; targetId: string };
};

/**
 * Starts a Polaris ID operation, queued; `operation.run` does the work. A repeat with the same key answers the
 * first operation; a second start while one is active answers 409 naming it. Platform admins only (the route).
 */
async function startIdpOp(
  ctx: ServiceContext,
  auth: SessionAuth,
  spec: Spec,
): Promise<OperationDto> {
  const id = spec.idempotencyKey
    ? await operationIdFor(principalOf(auth), spec.kind, spec.idempotencyKey)
    : ctx.ids.id();
  const known = await rowById(ctx.env.DB, id);
  if (known) return toDto(known);
  const { operation, created } = await startOperationOnce(ctx, {
    id,
    kind: spec.kind,
    actor: { type: 'user', id: auth.userId },
    ...(spec.target ? { target: spec.target } : {}),
    ...(spec.subject ? { subject: spec.subject } : {}),
  });
  if (!created) return operation;
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: auth.userId,
    action: spec.audit.action,
    targetType: spec.audit.targetType,
    targetId: spec.audit.targetId,
    detail: { operationId: operation.id },
  });
  await sendOperationRun(ctx, operation.id, operation.attempt);
  return operation;
}

const limited = (ctx: ServiceContext, auth: SessionAuth) =>
  enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:idp-ops:${auth.userId}`);

function needBinding(ctx: ServiceContext): void {
  if (!idpConfigured(ctx.env))
    throw new UnavailableError(IDP_UNAVAILABLE_MESSAGE, 'IDP_UNAVAILABLE');
}

/** Check now, or a dry run (`dryRun`): one reconcile of every group. */
export async function startCheck(
  ctx: ServiceContext,
  auth: SessionAuth,
  dryRun: boolean,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  needBinding(ctx);
  await limited(ctx, auth);
  return startIdpOp(ctx, auth, {
    kind: dryRun ? 'idp.dry_run' : 'idp.check',
    idempotencyKey,
    audit: { action: dryRun ? 'idp.dry_run' : 'idp.check', targetType: 'idp', targetId: 'sync' },
  });
}

/** Restore a role the owner paused in Polaris ID. 409 when it is not paused. */
export async function startRestore(
  ctx: ServiceContext,
  auth: SessionAuth,
  userId: string,
  role: WritableRole,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  needBinding(ctx);
  await requireUser(ctx, userId);
  const paused = (await statesOfUser(ctx.env.DB, userId)).some(
    (s) => s.target === role && s.held_at,
  );
  if (!paused) throw new ConflictError('This role is not paused.', 'IDP_NOT_HELD');
  await limited(ctx, auth);
  return startIdpOp(ctx, auth, {
    kind: 'idp.restore',
    target: restoreTarget(userId, role),
    subject: { userId, role },
    idempotencyKey,
    audit: { action: 'idp.restore', targetType: 'user', targetId: userId },
  });
}

/** Clear the SCIM breaker. 409 when it is not tripped. */
export async function startBreakerClear(
  ctx: ServiceContext,
  auth: SessionAuth,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  if (!(await breakerOpen(ctx.env.DB, BREAKER_KEY, ctx.clock.now(), BREAKER_LATCH_MS)))
    throw new ConflictError('The SCIM breaker is not tripped.', 'IDP_BREAKER_CLOSED');
  await limited(ctx, auth);
  return startIdpOp(ctx, auth, {
    kind: 'idp.breaker_clear',
    idempotencyKey,
    audit: { action: 'idp.breaker_clear', targetType: 'idp', targetId: 'scim_breaker' },
  });
}
