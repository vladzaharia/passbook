import type { Personalization } from '../../../passkit/types.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { deliverPush } from '../delivery/push.ts';
import { recordPassEvent } from '../events/record.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { currentSummary, detailOf, toSummary } from './detail.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { requestRefresh } from './pass-service-refresh.ts';
import { type Mutation, publishPass } from './publish.ts';
import {
  type ConnectionPassContext,
  type FieldSources,
  listPasses,
  softDeletePass,
} from './repo.ts';
import { softDeletePassGranted } from './repo-pass-grants.ts';
import { captureConnectionTransferPending, connectionForPass } from './repo-read-connection.ts';
import { getPass, pendingPushId } from './repo-read-pass.ts';
import type { ScopeArg } from './scope.ts';

/** Workstream d owns this module; e, f and others call these. Keep the signatures. */
export interface Actor {
  type: 'user' | 'api_key' | 'system' | 'connection' | 'scanner';
  id: string | null;
}

const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function listPassSummaries(
  ctx: ServiceContext,
  query: Parameters<typeof listPasses>[1],
) {
  const page = await listPasses(ctx.env.DB, query);
  return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
}

export interface PassPatch {
  input?: Personalization;
  templateVersion?: string;
  externalId?: string | null;
  resetToConnection?: string[];
  notify?: boolean;
}

/** `null` values in `input` remove the field. Changed fields become `manual`. */
export async function updatePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  patch: PassPatch,
  options: { scope: ScopeArg; ifMatch?: number; authority?: TenantPassWrite },
) {
  let resetContext: ConnectionPassContext | undefined;
  if (patch.resetToConnection?.length) {
    const pass = await getPassForWrite(ctx.env.DB, passId, options.scope);
    if (pass.mode !== 'live')
      throw new ConflictError('Connections are only available in Live mode.', 'MODE_MISMATCH');
    if (
      !pass.connectionId ||
      !pass.externalRef ||
      pass.status !== 'active' ||
      pass.removedAt !== null
    )
      throw new ConflictError(
        'The pass is not linked to an active connection.',
        'PASS_CONNECTION_MISMATCH',
      );
    const connection = await connectionForPass(
      ctx.env.DB,
      pass.connectionId,
      pass.orgId,
      pass.mode,
    );
    if (!connection) throw new ConflictError('The connection is unavailable.', 'PASS_CONFLICT');
    const transferPending = await captureConnectionTransferPending(ctx.env.DB, pass);
    if (transferPending !== false)
      throw new ConflictError('The pass or connection changed. Retry.', 'PASS_CONFLICT');
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
    resetContext = {
      passId: pass.id,
      orgId: pass.orgId,
      mode: 'live',
      status: pass.status,
      expectedVersion: pass.version,
      ownerUserId: pass.ownerUserId,
      linkGeneration: pass.linkGeneration,
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      credentialKeysetCommitment,
      transferPending,
      connectionId: pass.connectionId,
      externalRef: pass.externalRef,
      generation: connection.generation,
      expectedConnectionMode: connection.mode,
    };
  }
  const changedKeys: string[] = [];
  const result = await publishPass(ctx, {
    passId,
    orgScope: options.scope,
    cause: causeOf(actor),
    actor,
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.ifMatch !== undefined ? { expectedVersion: options.ifMatch } : {}),
    ...(resetContext ? { connectionContext: resetContext } : {}),
    notify: patch.notify === true,
    mutate: (current): Mutation => {
      changedKeys.length = 0;
      const personalization: Personalization = { ...current.personalization };
      const fieldSources: FieldSources = { ...current.fieldSources };
      for (const [key, value] of Object.entries(patch.input ?? {})) {
        if (value === null) delete personalization[key];
        else personalization[key] = value;
        if (!sameJson(current.personalization[key], value ?? undefined)) {
          changedKeys.push(key);
          fieldSources[key] = 'manual';
        }
      }
      for (const key of patch.resetToConnection ?? []) delete fieldSources[key];
      return {
        personalization,
        fieldSources,
        ...(patch.templateVersion !== undefined ? { templateVersion: patch.templateVersion } : {}),
        ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}),
      };
    },
  });
  await recordAudit(ctx, {
    orgId: result.pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.update',
    targetType: 'pass',
    targetId: passId,
    detail: {
      fields: changedKeys,
      reset: patch.resetToConnection ?? [],
      published: result.changed,
    },
  });
  if (patch.resetToConnection?.length && result.pass.connectionId)
    await requestRefresh(
      ctx,
      passId,
      actor,
      {
        orgId: result.pass.orgId,
        mode: result.pass.mode,
        version: result.pass.version,
        linkGeneration: result.pass.linkGeneration,
        identityId: result.pass.identityId,
        templateId: result.pass.templateId,
        templateVersion: result.pass.templateVersion,
        releaseId: result.pass.releaseId,
        credentialGeneration: result.pass.credentialGeneration,
        lifecycleGeneration: result.pass.lifecycleGeneration,
        status: result.pass.status,
        connectionId: result.pass.connectionId,
        externalRef: result.pass.externalRef,
        ...(resetContext
          ? {
              connectionGeneration: resetContext.generation,
              connectionMode: resetContext.expectedConnectionMode,
              credentialKeysetCommitment: resetContext.credentialKeysetCommitment,
            }
          : {}),
      },
      options.authority,
    );
  return detailOf(
    ctx,
    (await getPass(ctx.env.DB, passId, options.scope)) ?? result.pass,
    options.authority,
  );
}

async function setStatus(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  status: 'active' | 'voided',
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const current = await getPassForWrite(ctx.env.DB, passId, scope);
  if (current.removedAt !== null)
    throw new ConflictError('This pass was removed from Wallet. Restore it first.', 'PASS_REMOVED');
  const result = await publishPass(ctx, {
    passId,
    orgScope: scope,
    cause: causeOf(actor),
    actor,
    ...(authority ? { authority } : {}),
    mutate: () => ({ status }),
  });
  await recordAudit(ctx, {
    orgId: result.pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: status === 'voided' ? 'pass.void' : 'pass.unvoid',
    targetType: 'pass',
    targetId: passId,
  });
  await recordPassEvent(ctx, {
    orgId: result.pass.orgId,
    passId,
    mode: result.pass.mode,
    kind: status === 'voided' ? 'pass.voided' : 'pass.unvoided',
    actor,
  });
  return currentSummary(ctx, result.pass, authority);
}

export const voidPass = (
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: ScopeArg,
  authority?: TenantPassWrite,
) => setStatus(ctx, actor, id, 'voided', scope, authority);
export const unvoidPass = (
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: ScopeArg,
  authority?: TenantPassWrite,
) => setStatus(ctx, actor, id, 'active', scope, authority);

/**
 * Voids and pushes, then soft-deletes. The voided pass stays available to registered devices
 * until the retention job removes it.
 */
export async function deletePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
  authority?: TenantPassWrite,
): Promise<void> {
  let pass = await getPassForWrite(ctx.env.DB, passId, scope);
  if (pass.status === 'active') {
    pass = (
      await publishPass(ctx, {
        passId,
        orgScope: scope,
        cause: causeOf(actor),
        actor,
        ...(authority ? { authority } : {}),
        mutate: () => ({ status: 'voided' }),
      })
    ).pass;
    const pushId = await pendingPushId(ctx.env.DB, passId);
    if (pushId) {
      try {
        await deliverPush(ctx, pushId);
      } catch (error) {
        ctx.log.warn('pass.delete_push_failed', { passId, code: 'DELETE_PUSH', error });
      }
    }
  }
  const deleted = authority
    ? await softDeletePassGranted(ctx, pass, authority)
    : await softDeletePass(ctx.env.DB, pass, ctx.clock.now());
  if (!deleted)
    throw new ConflictError('The pass or authorization changed. Retry.', 'PASS_CONFLICT');
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.delete',
    targetType: 'pass',
    targetId: passId,
  });
}
