import type { Mode } from '../../../shared/contracts/common.ts';
import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import type { TenantPassWrite } from './http.ts';
import { claimRefresh, matchesRefreshSnapshot } from './repo.ts';
import { claimRefreshGranted } from './repo-pass-grants.ts';
import { connectionForPass } from './repo-read-connection.ts';
import { getPass } from './repo-read-pass.ts';
import type { Actor } from './service.ts';

/** Claims `refresh_requested_at` (coalescing window from settings) and enqueues a `pass.refresh` job. */
export async function requestRefresh(
  ctx: ServiceContext,
  passId: string,
  actor: Actor,
  expected: {
    orgId: string;
    identityId: string;
    templateId: string;
    templateVersion: string;
    releaseId: string | null;
    mode: Mode;
    version: number;
    linkGeneration: number;
    credentialGeneration: number;
    lifecycleGeneration: number;
    status: 'active' | 'voided';
    connectionId: string | null;
    externalRef: string | null;
    connectionGeneration?: number | null;
    connectionMode?: ConnectionMode | null;
    credentialKeysetCommitment?: string;
    ownerUserId?: string;
  },
  authority?: TenantPassWrite,
): Promise<{ requestedAt: number; coalesced: boolean; cooldownSeconds: number }> {
  if (
    !expected?.orgId ||
    typeof expected.identityId !== 'string' ||
    !expected.identityId ||
    typeof expected.templateId !== 'string' ||
    !expected.templateId ||
    typeof expected.templateVersion !== 'string' ||
    !expected.templateVersion ||
    (expected.releaseId !== null &&
      (typeof expected.releaseId !== 'string' || !expected.releaseId)) ||
    (expected.mode !== 'live' && expected.mode !== 'test') ||
    (expected.status !== 'active' && expected.status !== 'voided') ||
    (expected.connectionId !== null && typeof expected.connectionId !== 'string') ||
    (expected.externalRef !== null && typeof expected.externalRef !== 'string') ||
    !Number.isSafeInteger(expected.version) ||
    expected.version < 1 ||
    !Number.isSafeInteger(expected.linkGeneration) ||
    expected.linkGeneration < 1 ||
    !Number.isSafeInteger(expected.credentialGeneration) ||
    expected.credentialGeneration < 1 ||
    (expected.credentialKeysetCommitment !== undefined &&
      (typeof expected.credentialKeysetCommitment !== 'string' ||
        !/^[0-9a-f]{64}$/.test(expected.credentialKeysetCommitment))) ||
    !Number.isSafeInteger(expected.lifecycleGeneration) ||
    expected.lifecycleGeneration < 0
  )
    throw new ConflictError('The pass context is missing. Reload.', 'PASS_CONFLICT');
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (
    pass.orgId !== expected.orgId ||
    pass.mode !== expected.mode ||
    pass.identityId !== expected.identityId ||
    pass.templateId !== expected.templateId ||
    pass.templateVersion !== expected.templateVersion ||
    pass.releaseId !== expected.releaseId ||
    pass.version !== expected.version ||
    pass.linkGeneration !== expected.linkGeneration ||
    pass.credentialGeneration !== expected.credentialGeneration ||
    pass.lifecycleGeneration !== expected.lifecycleGeneration ||
    pass.status !== expected.status ||
    pass.connectionId !== expected.connectionId ||
    pass.externalRef !== expected.externalRef ||
    (expected.ownerUserId !== undefined && pass.ownerUserId !== expected.ownerUserId) ||
    pass.deletedAt !== null ||
    pass.removedAt !== null
  )
    throw new ConflictError('The pass changed. Reload.', 'PASS_CONFLICT');
  let generation: number | null = null;
  let connectionMode: ConnectionMode | null = null;
  if (pass.connectionId !== null) {
    if (pass.status !== 'active')
      throw new ConflictError(
        'Only an active pass can be refreshed from a connection.',
        'PASS_CONFLICT',
      );
    if (pass.mode !== 'live' || !pass.externalRef)
      throw new ConflictError('The pass cannot use this connection.', 'PASS_CONNECTION_MISMATCH');
    const connection = await connectionForPass(
      ctx.env.DB,
      pass.connectionId,
      pass.orgId,
      pass.mode,
    );
    if (!connection) throw new ConflictError('The connection is unavailable.', 'PASS_CONFLICT');
    generation = connection.generation;
    connectionMode = connection.mode;
  } else if (pass.externalRef !== null) {
    throw new ConflictError('The pass connection is incomplete.', 'PASS_CONNECTION_MISMATCH');
  }
  if (expected.connectionGeneration !== undefined && expected.connectionGeneration !== generation)
    throw new ConflictError('The connection changed. Retry.', 'PASS_CONFLICT');
  if (expected.connectionMode !== undefined && expected.connectionMode !== connectionMode)
    throw new ConflictError('The connection changed. Retry.', 'PASS_CONFLICT');
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
  if (
    expected.credentialKeysetCommitment !== undefined &&
    expected.credentialKeysetCommitment !== credentialKeysetCommitment
  )
    throw new ConflictError('The credential keyset changed. Retry.', 'PASS_CONFLICT');
  const snapshot = {
    passId,
    orgId: pass.orgId,
    identityId: pass.identityId,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    mode: pass.mode,
    status: pass.status,
    passVersion: pass.version,
    connectionId: pass.connectionId,
    externalRef: pass.externalRef,
    generation,
    connectionMode,
    ownerUserId: pass.ownerUserId,
    linkGeneration: pass.linkGeneration,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    credentialKeysetCommitment,
  };
  const settings = await getPlatformSettings(ctx);
  const cooldownSeconds = settings['refresh.userCooldownSeconds'];
  const windowMs = cooldownSeconds * 1000;
  const now = ctx.clock.now();
  const claimed = authority
    ? await claimRefreshGranted(ctx, snapshot, windowMs, authority)
    : await claimRefresh(ctx.env.DB, snapshot, now, windowMs);
  if (!claimed) {
    if (!(await matchesRefreshSnapshot(ctx.env.DB, snapshot, authority, ctx.clock.now())))
      throw new ConflictError('The pass or connection changed. Retry.', 'PASS_CONFLICT');
    return { requestedAt: pass.refreshRequestedAt ?? now, coalesced: true, cooldownSeconds };
  }
  await ctx.env.JOBS.send({
    kind: 'pass.refresh',
    passId,
    trigger: actor.type === 'user' ? 'user' : 'admin',
    actorId: actor.id,
    orgId: snapshot.orgId,
    identityId: snapshot.identityId,
    templateId: snapshot.templateId,
    templateVersion: snapshot.templateVersion,
    releaseId: snapshot.releaseId,
    mode: snapshot.mode,
    status: snapshot.status,
    passVersion: snapshot.passVersion,
    connectionId: snapshot.connectionId,
    externalRef: snapshot.externalRef,
    generation: snapshot.generation,
    connectionMode: snapshot.connectionMode,
    ownerUserId: snapshot.ownerUserId,
    linkGeneration: snapshot.linkGeneration,
    credentialGeneration: snapshot.credentialGeneration,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
  });
  writeEvent(ctx.env, {
    event: 'refresh.requested',
    orgId: pass.orgId,
    templateId: pass.templateId,
    mode: pass.mode,
  });
  return { requestedAt: now, coalesced: false, cooldownSeconds };
}
