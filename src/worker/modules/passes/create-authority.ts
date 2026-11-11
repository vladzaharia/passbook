import { ConnectionModeSchema } from '../../../shared/contracts/connections.ts';
import { LEGACY_REVISION_MS } from '../../platform/authority-principal.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { CreateParams } from './create-types.ts';
import type { TenantPassWrite } from './http.ts';
import { tenantOrgUpdatedAt, tenantPassAuthorityValid } from './repo-authority.ts';
import { connectionForPass } from './repo-read-connection.ts';

/** A suspended (or suspended and reactivated) org is a distinct refusal from a lost membership or key. */
async function assertOrgUnchanged(ctx: ServiceContext, authority: TenantPassWrite): Promise<void> {
  const current = await tenantOrgUpdatedAt(ctx.env.DB, authority.orgId);
  const legacy = authority.orgUpdatedAt >= LEGACY_REVISION_MS;
  if (current === null || (!legacy && current !== authority.orgUpdatedAt))
    throw new ForbiddenError(
      'Organization access changed. Reload and retry.',
      'ORG_ACCESS_CHANGED',
    );
}

export async function assertTenantCreateAuthority(
  ctx: ServiceContext,
  p: CreateParams,
): Promise<void> {
  const execution = p.execution;
  if (
    !execution ||
    (execution.kind !== 'tenant' && execution.kind !== 'connection' && execution.kind !== 'system')
  )
    throw new ForbiddenError();
  if (
    execution.kind === 'connection' &&
    (p.source !== 'connection' ||
      !p.connectionId ||
      execution.connectionId !== p.connectionId ||
      typeof execution.generation !== 'number' ||
      !Number.isSafeInteger(execution.generation) ||
      execution.generation < 1 ||
      execution.generation !== p.connectionGeneration)
  )
    throw new ForbiddenError();
  const tenant = execution.kind === 'tenant' ? execution : undefined;
  const authority = tenant?.authority;
  if (tenant && !authority) throw new ForbiddenError();
  if (
    authority &&
    (authority.orgId !== p.orgId ||
      authority.mode !== p.mode ||
      (authority.kind !== 'session' && authority.kind !== 'api_key') ||
      (authority.kind === 'session' && authority.capability !== 'passes:operate') ||
      (authority.kind === 'api_key' && authority.scope !== 'passes:write') ||
      !(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
  ) {
    if (authority && authority.orgId === p.orgId && authority.mode === p.mode)
      await assertOrgUnchanged(ctx, authority);
    throw new ForbiddenError();
  }
  if (
    tenant?.sampleScannerScope !== undefined &&
    (p.source !== 'manual' ||
      p.mode !== 'test' ||
      tenant.additionalAuthority?.kind !== 'session' ||
      tenant.additionalAuthority.capability !== 'scanning:manage')
  )
    throw new ForbiddenError();
  const additional = tenant?.additionalAuthority;
  if (
    additional &&
    (!authority ||
      additional.orgId !== p.orgId ||
      additional.mode !== p.mode ||
      (authority.kind === 'session'
        ? additional.kind !== 'session' ||
          additional.userId !== authority.userId ||
          additional.sessionId !== authority.sessionId ||
          additional.membershipId !== authority.membershipId
        : additional.kind !== 'api_key' ||
          additional.keyId !== authority.keyId ||
          additional.keyOrgId !== authority.keyOrgId) ||
      !(await tenantPassAuthorityValid(ctx.env.DB, additional, ctx.clock.now())))
  )
    throw new ForbiddenError();
  if (p.source === 'connection' && p.mode !== 'live')
    throw new ConflictError('Connection syncs require Live mode.', 'MODE_MISMATCH');
  if (p.source === 'connection' && p.expectedConnectionMode === undefined)
    throw new ConflictError(
      'The connection run is missing its original strategy.',
      'PASS_CONFLICT',
    );
  if (
    p.expectedConnectionMode !== undefined &&
    (!p.connectionId || !ConnectionModeSchema.options.includes(p.expectedConnectionMode))
  )
    throw new ConflictError('The connection context is invalid.', 'PASS_CONFLICT');
  if (p.source === 'connection') {
    if (
      !p.connectionId ||
      typeof p.connectionGeneration !== 'number' ||
      !Number.isSafeInteger(p.connectionGeneration) ||
      p.connectionGeneration < 1
    )
      throw new ConflictError(
        'The connection run is missing its original context.',
        'PASS_CONFLICT',
      );
    const connection = await connectionForPass(
      ctx.env.DB,
      p.connectionId,
      p.orgId,
      p.mode,
      p.expectedConnectionMode,
    );
    if (!connection || connection.generation !== p.connectionGeneration)
      throw new ConflictError('The connection changed. Reload and retry.', 'PASS_CONFLICT');
  }
}
