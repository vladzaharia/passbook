import type { StartSetup } from '../../../shared/contracts/idp-setup.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
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
import { desiredState } from './desired.ts';
import { IDP_UNAVAILABLE_MESSAGE } from './errors.ts';
import { restoreTarget } from './ops-runs.ts';
import { latchedAt } from './repo-scim.ts';
import { statesOfUser } from './repo-state.ts';
import { BREAKER_KEY, BREAKER_LATCH_MS } from './scim-effects.ts';
import { setupTarget } from './setup-run.ts';
import { rotateTarget } from './setup-token.ts';
import type { WritableRole } from './types.ts';

type Spec = {
  kind:
    | 'idp.check'
    | 'idp.dry_run'
    | 'idp.restore'
    | 'idp.breaker_clear'
    | 'idp.offboard'
    | 'idp.setup'
    | 'idp.scim_rotate';
  target?: { type: string; id: string };
  subject?: Record<string, string>;
  idempotencyKey: string | undefined;
  /** The audit row for the start: who did it, to what. `null`: a preview writes none. */
  audit: {
    action: string;
    targetType: string;
    targetId: string;
    detail?: Record<string, unknown>;
  } | null;
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
  auth: SessionAuth | ApiKeyAuth,
  kind: Spec['kind'],
  key: string | undefined,
  target?: Spec['target'],
): Promise<OperationDto | null> {
  return key
    ? replayOf(ctx, await operationIdFor(principalOf(auth), kind, key), kind, target)
    : null;
}

/**
 * Starts a Polaris ID operation, queued; `operation.run` does the work. A repeat with the same key answers the
 * first operation; a second start while one is active answers 409 naming it. Platform admins only (the route).
 */
export async function startIdpOp(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  spec: Spec,
): Promise<OperationDto> {
  const actor = actorOf(auth);
  const id = spec.idempotencyKey
    ? await operationIdFor(principalOf(auth), spec.kind, spec.idempotencyKey)
    : ctx.ids.id();
  const known = await replayOf(ctx, id, spec.kind, spec.target);
  if (known) return known;
  const { operation, created } = await startOperationOnce(ctx, {
    id,
    kind: spec.kind,
    actor,
    ...(spec.target ? { target: spec.target } : {}),
    ...(spec.subject ? { subject: spec.subject } : {}),
  });
  if (!created) return operation;
  if (spec.audit)
    await recordAudit(ctx, {
      actorType: actor.type,
      actorId: actor.id,
      action: spec.audit.action,
      targetType: spec.audit.targetType,
      targetId: spec.audit.targetId,
      detail: spec.audit.detail ?? { operationId: operation.id },
    });
  await sendOperationRun(ctx, operation.id, operation.attempt);
  return operation;
}

/** Who started an operation: a person, or the Platform key that did (setup and rotation accept both). */
const actorOf = (auth: SessionAuth | ApiKeyAuth) =>
  auth.kind === 'session'
    ? ({ type: 'user', id: auth.userId } as const)
    : ({ type: 'api_key', id: auth.keyId } as const);

export const limited = (ctx: ServiceContext, auth: SessionAuth | ApiKeyAuth) =>
  enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:idp-ops:${actorOf(auth).id}`);

export function needBinding(ctx: ServiceContext): void {
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
  const kind = dryRun ? 'idp.dry_run' : 'idp.check';
  const again = await replay(ctx, auth, kind, idempotencyKey);
  if (again) return again;
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
  const target = restoreTarget(userId, role);
  const again = await replay(ctx, auth, 'idp.restore', idempotencyKey, target);
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
  await limited(ctx, auth);
  return startIdpOp(ctx, auth, {
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
  auth: SessionAuth,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  const again = await replay(ctx, auth, 'idp.breaker_clear', idempotencyKey);
  if (again) return again;
  const trippedAt = await latchedAt(ctx.env.DB, BREAKER_KEY, ctx.clock.now(), BREAKER_LATCH_MS);
  if (trippedAt === null)
    throw new ConflictError('The SCIM breaker is not tripped.', 'IDP_BREAKER_CLOSED');
  await limited(ctx, auth);
  return startIdpOp(ctx, auth, {
    kind: 'idp.breaker_clear',
    // The trip the admin saw: the run clears that one, never a later one.
    target: { type: 'scim_breaker', id: String(trippedAt) },
    idempotencyKey,
    audit: { action: 'idp.breaker_clear', targetType: 'idp', targetId: 'scim_breaker' },
  });
}

/**
 * Set up Polaris ID, or preview it: a dry run unless `dryRun` is false, and a preview writes nothing, audit
 * included. The run's choices ride in the target, so a replay with another body is a different request.
 */
export async function startSetup(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  body: StartSetup,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  const target = setupTarget(body.dryRun, body.items);
  const again = await replay(ctx, auth, 'idp.setup', idempotencyKey, target);
  if (again) return again;
  needBinding(ctx);
  await limited(ctx, auth);
  return startIdpOp(ctx, auth, {
    kind: 'idp.setup',
    target,
    idempotencyKey,
    audit: body.dryRun
      ? null
      : { action: 'idp.setup', targetType: 'idp', targetId: 'setup', detail: { dryRun: false } },
  });
}

/** Rotate the SCIM token, or preview it. */
export async function startRotate(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  dryRun: boolean,
  idempotencyKey: string | undefined,
): Promise<OperationDto> {
  const target = rotateTarget(dryRun);
  const again = await replay(ctx, auth, 'idp.scim_rotate', idempotencyKey, target);
  if (again) return again;
  needBinding(ctx);
  await limited(ctx, auth);
  return startIdpOp(ctx, auth, {
    kind: 'idp.scim_rotate',
    target,
    idempotencyKey,
    audit: dryRun
      ? null
      : {
          action: 'idp.scim_rotate',
          targetType: 'idp',
          targetId: 'scim_token',
          detail: { dryRun: false },
        },
  });
}
