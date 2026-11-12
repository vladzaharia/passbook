import type { z } from 'zod';
import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import type { BindPassConnectionSchema } from '../../../shared/contracts/index.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { detailOf } from './detail.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { requestRefresh } from './pass-service-refresh.ts';
import { type FieldSources, setBinding } from './repo.ts';
import { connectionForPass, connectionInOrg, findByConnectionRef } from './repo-read-connection.ts';
import { getPass } from './repo-read-pass.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

const refTaken = () =>
  new ConflictError('That connection ref already has a pass.', 'PASS_REF_TAKEN');

/** Binds (or, with nulls, unbinds) an existing pass to an upstream ref, then queues a refresh. */
export async function bindPassConnection(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  body: z.infer<typeof BindPassConnectionSchema>,
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const db = ctx.env.DB;
  const pass = await getPassForWrite(db, passId, scope);
  const { connectionId, externalRef } = body;
  if (pass.removedAt !== null)
    throw new ConflictError('This pass was removed from Wallet. Restore it first.', 'PASS_REMOVED');
  if (pass.mode === 'test' && pass.connectionId !== null)
    throw new ConflictError('This Test pass has an unsafe Live connection.', 'MODE_MISMATCH');
  let generation: number | null = null;
  let connectionMode: ConnectionMode | null = null;
  let fieldSources: FieldSources = pass.fieldSources;
  if (connectionId !== null && externalRef !== null) {
    if (pass.mode !== 'live')
      throw new ConflictError('Connections are only available in Live mode.', 'MODE_MISMATCH');
    if (pass.status !== 'active')
      throw new ConflictError('Only an active pass can be connected.', 'PASS_CONFLICT');
    if (!(await connectionInOrg(db, connectionId, pass.orgId)))
      throw new ValidationError(
        'The connection does not belong to this organization.',
        [],
        'CONNECTION_ORG',
      );
    const connection = await connectionForPass(db, connectionId, pass.orgId, pass.mode);
    if (!connection) throw new ConflictError('The connection is unavailable.', 'PASS_CONFLICT');
    generation = connection.generation;
    connectionMode = connection.mode;
    const holder = await findByConnectionRef(db, pass.orgId, connectionId, externalRef);
    if (holder && holder !== pass.id) throw refTaken();
    const owned: FieldSources = Object.fromEntries(
      Object.keys(pass.personalization).map((k) => [k, 'connection' as const]),
    );
    // Default: the connection takes over every field. false keeps the current sources.
    fieldSources = body.resetFieldSources === false ? { ...owned, ...pass.fieldSources } : owned;
  }
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, ctx.env);
  try {
    if (
      !(await setBinding(
        ctx,
        pass,
        { connectionId, externalRef, fieldSources, generation, connectionMode },
        authority,
      ))
    )
      throw new ConflictError('The pass or connection changed. Retry.', 'PASS_CONFLICT');
  } catch (error) {
    const info = classifyD1Error(error);
    if (info?.kind === 'unique' && /passes\.external_ref/.test(info.detail)) throw refTaken();
    throw error;
  }
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: connectionId ? 'pass.bind' : 'pass.unbind',
    targetType: 'pass',
    targetId: pass.id,
    detail: { connectionId, externalRef },
  });
  if (connectionId)
    await requestRefresh(
      ctx,
      pass.id,
      actor,
      {
        orgId: pass.orgId,
        identityId: pass.identityId,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        releaseId: pass.releaseId,
        mode: pass.mode,
        version: pass.version + 1,
        linkGeneration: pass.linkGeneration,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        status: pass.status,
        connectionId,
        externalRef,
        connectionGeneration: generation,
        connectionMode,
        credentialKeysetCommitment,
      },
      authority,
    );
  return detailOf(ctx, (await getPass(db, pass.id, scope)) ?? pass, authority);
}
