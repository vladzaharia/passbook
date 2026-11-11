import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { deliverPush } from '../delivery/push.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { createPassRow } from './create.ts';
import { detailOf, linksOf, toSummary } from './detail.ts';
import { getPassForWrite } from './pass-access.ts';
import { type Mutation, publishPass } from './publish.ts';
import {
  claimRefresh,
  connectionForPass,
  type ConnectionPassContext,
  type FieldSources,
  getPass,
  listPasses,
  matchesRefreshSnapshot,
  pendingPushId,
  setDownloadToken,
  softDeletePass,
} from './repo.ts';
import type { ScopeArg } from './scope.ts';

/** Workstream d owns this module; e, f and others call these. Keep the signatures. */
export interface Actor {
  type: 'user' | 'api_key' | 'system' | 'connection' | 'scanner';
  id: string | null;
}

const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export { createPassRow };

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
  options: { scope: ScopeArg; ifMatch?: number },
) {
  let resetContext: ConnectionPassContext | undefined;
  if (patch.resetToConnection?.length) {
    const pass = await getPassForWrite(ctx.env.DB, passId, options.scope);
    if (pass.mode !== 'live')
      throw new ConflictError('Connections are only available in Live mode.', 'MODE_MISMATCH');
    if (!pass.connectionId || !pass.externalRef || pass.status !== 'active' || pass.removedAt !== null)
      throw new ConflictError('The pass is not linked to an active connection.', 'PASS_CONNECTION_MISMATCH');
    const connection = await connectionForPass(ctx.env.DB, pass.connectionId, pass.orgId, pass.mode);
    if (!connection) throw new ConflictError('The connection is unavailable.', 'PASS_CONFLICT');
    resetContext = {
      passId: pass.id, orgId: pass.orgId, mode: 'live', status: pass.status,
      expectedVersion: pass.version, ownerUserId: pass.ownerUserId, linkGeneration: pass.linkGeneration,
      connectionId: pass.connectionId, externalRef: pass.externalRef, generation: connection.generation,
    };
  }
  const changedKeys: string[] = [];
  const result = await publishPass(ctx, {
    passId,
    orgScope: options.scope,
    cause: causeOf(actor),
    actor,
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
        ...(patch.templateVersion ? { templateVersion: patch.templateVersion } : {}),
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
    await requestRefresh(ctx, passId, actor, {
      orgId: result.pass.orgId,
      mode: result.pass.mode,
      version: result.pass.version,
      linkGeneration: result.pass.linkGeneration,
      status: result.pass.status,
      connectionId: result.pass.connectionId,
      externalRef: result.pass.externalRef,
      ...(resetContext ? { connectionGeneration: resetContext.generation } : {}),
    });
  return detailOf(ctx, (await getPass(ctx.env.DB, passId)) ?? result.pass);
}

async function setStatus(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  status: 'active' | 'voided',
  scope: ScopeArg,
) {
  const current = await getPassForWrite(ctx.env.DB, passId, scope);
  if (current.removedAt !== null)
    throw new ConflictError('This pass was removed from Wallet. Restore it first.', 'PASS_REMOVED');
  const result = await publishPass(ctx, {
    passId,
    orgScope: scope,
    cause: causeOf(actor),
    actor,
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
  return toSummary(result.pass);
}

export const voidPass = (ctx: ServiceContext, actor: Actor, id: string, scope: ScopeArg) =>
  setStatus(ctx, actor, id, 'voided', scope);
export const unvoidPass = (ctx: ServiceContext, actor: Actor, id: string, scope: ScopeArg) =>
  setStatus(ctx, actor, id, 'active', scope);

/**
 * Voids and pushes, then soft-deletes. The voided pass stays available to registered devices
 * until the retention job removes it.
 */
export async function deletePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
): Promise<void> {
  let pass = await getPassForWrite(ctx.env.DB, passId, scope);
  if (pass.status === 'active') {
    pass = (
      await publishPass(ctx, {
        passId,
        orgScope: scope,
        cause: causeOf(actor),
        actor,
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
  await softDeletePass(ctx.env.DB, pass.id, ctx.clock.now());
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.delete',
    targetType: 'pass',
    targetId: passId,
  });
}

export async function rotateLink(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const token = ctx.ids.token();
  await setDownloadToken(ctx.env.DB, passId, token, ctx.clock.now());
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.rotate_link',
    targetType: 'pass',
    targetId: passId,
  });
  await recordPassEvent(ctx, {
    orgId: pass.orgId,
    passId,
    mode: pass.mode,
    kind: 'pass.link_rotated',
    actor,
  });
  const { publicUrl, downloadUrl } = linksOf(ctx, { ...pass, downloadToken: token });
  return { publicUrl, downloadUrl };
}

export async function resendEmail(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  input: { to?: string; attach?: boolean },
  scope: ScopeArg,
): Promise<void> {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  if (pass.removedAt !== null)
    throw new ConflictError('This pass was removed from Wallet. Restore it first.', 'PASS_REMOVED');
  const to = input.to ?? pass.holderEmail;
  if (!to) throw new ValidationError('The pass has no holder email.', [], 'NO_RECIPIENT');
  // API keys may not turn resend into a mail relay.
  if (actor.type !== 'user' && to.toLowerCase() !== pass.holderEmail?.toLowerCase())
    throw new ValidationError('Only the holder email can be used.', [], 'RECIPIENT_NOT_HOLDER');
  await enqueuePassEmail(ctx, { passId, to, attach: input.attach ?? false, expected: pass });
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.resend_email',
    targetType: 'pass',
    targetId: passId,
  });
}

/** Claims `refresh_requested_at` (coalescing window from settings) and enqueues a `pass.refresh` job. */
export async function requestRefresh(
  ctx: ServiceContext,
  passId: string,
  actor: Actor,
  expected: {
    orgId: string;
    mode: Mode;
    version: number;
    linkGeneration: number;
    status: 'active' | 'voided';
    connectionId: string | null;
    externalRef: string | null;
    connectionGeneration?: number | null;
    ownerUserId?: string;
  },
): Promise<{ requestedAt: number; coalesced: boolean; cooldownSeconds: number }> {
  if (
    !expected || !expected.orgId || (expected.mode !== 'live' && expected.mode !== 'test') ||
    (expected.status !== 'active' && expected.status !== 'voided') ||
    (expected.connectionId !== null && typeof expected.connectionId !== 'string') ||
    (expected.externalRef !== null && typeof expected.externalRef !== 'string') ||
    !Number.isSafeInteger(expected.version) || expected.version < 1 ||
    !Number.isSafeInteger(expected.linkGeneration) || expected.linkGeneration < 1
  )
    throw new ConflictError('The pass context is missing. Reload.', 'PASS_CONFLICT');
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (
    pass.orgId !== expected.orgId || pass.mode !== expected.mode ||
    pass.version !== expected.version || pass.linkGeneration !== expected.linkGeneration ||
    pass.status !== expected.status || pass.connectionId !== expected.connectionId ||
    pass.externalRef !== expected.externalRef ||
    (expected.ownerUserId !== undefined && pass.ownerUserId !== expected.ownerUserId) ||
    pass.deletedAt !== null || pass.removedAt !== null
  )
    throw new ConflictError('The pass changed. Reload.', 'PASS_CONFLICT');
  let generation: number | null = null;
  if (pass.connectionId !== null) {
    if (pass.status !== 'active')
      throw new ConflictError('Only an active pass can be refreshed from a connection.', 'PASS_CONFLICT');
    if (pass.mode !== 'live' || !pass.externalRef)
      throw new ConflictError('The pass cannot use this connection.', 'PASS_CONNECTION_MISMATCH');
    const connection = await connectionForPass(ctx.env.DB, pass.connectionId, pass.orgId, pass.mode);
    if (!connection) throw new ConflictError('The connection is unavailable.', 'PASS_CONFLICT');
    generation = connection.generation;
  } else if (pass.externalRef !== null) {
    throw new ConflictError('The pass connection is incomplete.', 'PASS_CONNECTION_MISMATCH');
  }
  if (expected.connectionGeneration !== undefined && expected.connectionGeneration !== generation)
    throw new ConflictError('The connection changed. Retry.', 'PASS_CONFLICT');
  const snapshot = {
    passId,
    orgId: pass.orgId,
    mode: pass.mode,
    status: pass.status,
    passVersion: pass.version,
    connectionId: pass.connectionId,
    externalRef: pass.externalRef,
    generation,
    ownerUserId: pass.ownerUserId,
    linkGeneration: pass.linkGeneration,
  };
  const now = ctx.clock.now();
  const settings = await getPlatformSettings(ctx);
  const cooldownSeconds = settings['refresh.userCooldownSeconds'];
  const windowMs = cooldownSeconds * 1000;
  if (!(await claimRefresh(ctx.env.DB, snapshot, now, windowMs))) {
    if (!(await matchesRefreshSnapshot(ctx.env.DB, snapshot)))
      throw new ConflictError('The pass or connection changed. Retry.', 'PASS_CONFLICT');
    return { requestedAt: pass.refreshRequestedAt ?? now, coalesced: true, cooldownSeconds };
  }
  await ctx.env.JOBS.send({
    kind: 'pass.refresh',
    passId,
    trigger: actor.type === 'user' ? 'user' : 'admin',
    actorId: actor.id,
    orgId: snapshot.orgId,
    mode: snapshot.mode,
    status: snapshot.status,
    passVersion: snapshot.passVersion,
    connectionId: snapshot.connectionId,
    externalRef: snapshot.externalRef,
    generation: snapshot.generation,
    ownerUserId: snapshot.ownerUserId,
    linkGeneration: snapshot.linkGeneration,
  });
  writeEvent(ctx.env, {
    event: 'refresh.requested',
    orgId: pass.orgId,
    templateId: pass.templateId,
    mode: pass.mode,
  });
  return { requestedAt: now, coalesced: false, cooldownSeconds };
}

export * from './connection-passes.ts';

/** Throws unless the pass exists inside the scope and may be changed from it. */
export async function requirePass(ctx: ServiceContext, id: string, scope: ScopeArg): Promise<void> {
  await getPassForWrite(ctx.env.DB, id, scope);
}
