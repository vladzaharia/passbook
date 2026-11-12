import { ConnectionModeSchema } from '../../../shared/contracts/connections.ts';
import type { JobOf } from '../../jobs/types.ts';
import { type Grant, jobGrant } from '../../platform/authority.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { DELIVERY_CODES } from './delivery-actor.ts';
import { connectionCheck, noPendingTransfer } from './repo-delivery-checks.ts';

export type RefreshPushContext = Pick<
  JobOf<'pass.refresh'>,
  | 'passId'
  | 'orgId'
  | 'identityId'
  | 'templateId'
  | 'templateVersion'
  | 'releaseId'
  | 'mode'
  | 'passVersion'
  | 'status'
  | 'ownerUserId'
  | 'linkGeneration'
  | 'credentialGeneration'
  | 'lifecycleGeneration'
  | 'credentialKeysetCommitment'
  | 'connectionId'
  | 'externalRef'
  | 'generation'
  | 'connectionMode'
>;

function validRefresh(context: RefreshPushContext): boolean {
  if (
    !context ||
    typeof context.passId !== 'string' ||
    !context.passId ||
    typeof context.orgId !== 'string' ||
    !context.orgId ||
    typeof context.identityId !== 'string' ||
    !context.identityId ||
    typeof context.templateId !== 'string' ||
    !context.templateId ||
    typeof context.templateVersion !== 'string' ||
    !context.templateVersion ||
    (context.releaseId !== null && (typeof context.releaseId !== 'string' || !context.releaseId)) ||
    typeof context.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(context.credentialKeysetCommitment) ||
    !Number.isSafeInteger(context.passVersion) ||
    context.passVersion < 1 ||
    !Number.isSafeInteger(context.linkGeneration) ||
    context.linkGeneration < 1 ||
    !Number.isSafeInteger(context.credentialGeneration) ||
    context.credentialGeneration < 1 ||
    !Number.isSafeInteger(context.lifecycleGeneration) ||
    context.lifecycleGeneration < 0 ||
    (context.mode !== 'live' && context.mode !== 'test') ||
    (context.status !== 'active' && context.status !== 'voided') ||
    (context.ownerUserId !== null && typeof context.ownerUserId !== 'string')
  )
    return false;
  if (
    context.connectionId === null
      ? context.externalRef !== null ||
        context.generation !== null ||
        context.connectionMode !== null
      : typeof context.connectionId !== 'string' ||
        !context.connectionId ||
        typeof context.externalRef !== 'string' ||
        !context.externalRef ||
        !Number.isSafeInteger(context.generation) ||
        (context.generation ?? 0) < 1 ||
        !ConnectionModeSchema.safeParse(context.connectionMode).success
  )
    return false;
  return true;
}

/**
 * The refresh stamp and push run under a job grant for this pass: the org is active, the pass is
 * in the lineage the refresh captured, no transfer is pending, and a connection-backed pass still
 * has its connection enabled at the captured generation and mode. The keyset commitment is pinned
 * once by the caller.
 */
function refreshGrant(ctx: ServiceContext, context: RefreshPushContext, push: boolean): Grant {
  const connected = context.connectionId !== null;
  return jobGrant(ctx, {
    job: 'refresh',
    purpose: connected
      ? `org_mode.connection.job.refresh_${push ? 'push' : 'stamp'}`
      : `org_mode.job.refresh_${push ? 'push' : 'stamp'}`,
    orgId: context.orgId,
    mode: context.mode,
    target: context.passId,
    codes: DELIVERY_CODES,
    checks: [
      rowIs('passes', context.passId, {
        status: context.status,
        version: context.passVersion,
        owner_user_id: context.ownerUserId,
        link_generation: context.linkGeneration,
        identity_id: context.identityId,
        credential_generation: context.credentialGeneration,
        lifecycle_generation: context.lifecycleGeneration,
        template_id: context.templateId,
        template_version: context.templateVersion,
        release_id: context.releaseId,
        connection_id: context.connectionId,
        external_ref: context.externalRef,
        removed_at: null,
        deleted_at: null,
        test_data_quarantined: 0,
      }),
      noPendingTransfer(context.passId),
      ...(context.connectionId !== null && context.generation !== null
        ? [
            connectionCheck({
              connectionId: context.connectionId,
              generation: context.generation,
              mode: context.connectionMode,
            }),
          ]
        : []),
    ],
  });
}

/** The keyset commitment is immutable; pinning it once here replaces the per-statement SQL proof. */
async function keysetMatches(ctx: ServiceContext, context: RefreshPushContext): Promise<boolean> {
  return (
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) === context.credentialKeysetCommitment
  );
}

/** Stamp a refresh whose successful publication already committed its own push. */
export async function markRefreshCompleted(
  ctx: ServiceContext,
  context: RefreshPushContext,
  now: number,
): Promise<boolean> {
  if (!validRefresh(context) || (context.connectionId !== null && context.mode !== 'live'))
    return false;
  if (!(await keysetMatches(ctx, context))) return false;
  const g = refreshGrant(ctx, context, false);
  g.update('passes', {
    set: { last_refreshed_at: now },
    where: { id: context.passId },
    returning: ['id'],
  });
  return stamped(g);
}

async function stamped(g: Grant): Promise<boolean> {
  try {
    const results = await g.commit();
    return (results[0]?.results.length ?? 0) === 1;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

/**
 * The timestamp and outbox insertion share a transaction. Both are tested against the captured
 * binding at commit, including the current connection and organization state. A push already
 * pending under the same coalescing key is not duplicated; the pass is still stamped.
 */
export async function insertRefreshPush(
  ctx: ServiceContext,
  context: RefreshPushContext,
  id: string,
  now: number,
): Promise<boolean> {
  if (
    !validRefresh(context) ||
    (context.connectionId !== null && (context.status !== 'active' || context.mode !== 'live'))
  )
    return false;
  if (!(await keysetMatches(ctx, context))) return false;
  const coalesceKey = `push:${JSON.stringify([
    context.passId,
    context.identityId,
    context.credentialGeneration,
    context.lifecycleGeneration,
    context.templateId,
    context.templateVersion,
    context.releaseId,
  ])}`;
  const pending = await first(ctx.env.DB, 'SELECT 1 FROM outbox WHERE coalesce_key = ?', [
    coalesceKey,
  ]);
  const g = refreshGrant(ctx, context, true);
  g.update('passes', {
    set: { last_refreshed_at: now },
    where: { id: context.passId },
    returning: ['id'],
  });
  if (!pending)
    g.insertSelect(
      'outbox',
      ['id', 'kind', 'pass_id', 'coalesce_key', 'payload', 'state', 'available_at', 'created_at'],
      [
        id,
        'push',
        context.passId,
        coalesceKey,
        JSON.stringify({
          reason: 'refresh',
          identityId: context.identityId,
          templateId: context.templateId,
          templateVersion: context.templateVersion,
          releaseId: context.releaseId,
          credentialGeneration: context.credentialGeneration,
          lifecycleGeneration: context.lifecycleGeneration,
        }),
        'pending',
        0,
        now,
      ],
    );
  return stamped(g);
}
