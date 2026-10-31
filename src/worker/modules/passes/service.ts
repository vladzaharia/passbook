import type { Personalization } from '../../../passkit/types.ts';
import { strictEmail } from '../../../shared/email.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { deliverPush } from '../delivery/push.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { assignHolder } from '../holders/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { createPassIdempotent, createPassRow } from './create.ts';
import { detailOf, linksOf, toSummary } from './detail.ts';
import { type Mutation, publishPass } from './publish.ts';
import {
  claimRefresh,
  connectionGeneration,
  type FieldSources,
  findByConnectionRef,
  getPass,
  listPasses,
  pendingPushId,
  setDownloadToken,
  setSyncError,
  softDeletePass,
} from './repo.ts';

/** Workstream d owns this module; e, f and others call these. Keep the signatures. */
export interface Actor {
  type: 'user' | 'api_key' | 'system' | 'connection';
  id: string | null;
}

const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export { getPassDetail } from './detail.ts';
export { createPassIdempotent, createPassRow };

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
}

/** `null` values in `input` remove the field. Changed fields become `manual`. */
export async function updatePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  patch: PassPatch,
  options: { scope: string | null; ifMatch?: number },
) {
  const changedKeys: string[] = [];
  const result = await publishPass(ctx, {
    passId,
    orgScope: options.scope,
    cause: causeOf(actor),
    actor,
    ...(options.ifMatch !== undefined ? { expectedVersion: options.ifMatch } : {}),
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
    await requestRefresh(ctx, passId, actor);
  return detailOf(ctx, (await getPass(ctx.env.DB, passId)) ?? result.pass);
}

async function setStatus(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  status: 'active' | 'voided',
  scope: string | null,
) {
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
  return toSummary(result.pass);
}

export const voidPass = (ctx: ServiceContext, actor: Actor, id: string, scope: string | null) =>
  setStatus(ctx, actor, id, 'voided', scope);
export const unvoidPass = (ctx: ServiceContext, actor: Actor, id: string, scope: string | null) =>
  setStatus(ctx, actor, id, 'active', scope);

/**
 * Voids and pushes, then soft-deletes. The voided pass stays available to registered devices
 * until the retention job removes it.
 */
export async function deletePass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: string | null,
): Promise<void> {
  let pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
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
  scope: string | null,
) {
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
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
  const { publicUrl, downloadUrl } = linksOf(ctx, { ...pass, downloadToken: token });
  return { publicUrl, downloadUrl };
}

export async function resendEmail(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  input: { to?: string; attach?: boolean },
  scope: string | null,
): Promise<void> {
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const to = input.to ?? pass.holderEmail;
  if (!to) throw new ValidationError('The pass has no holder email.', [], 'NO_RECIPIENT');
  await enqueuePassEmail(ctx, { passId, to, attach: input.attach ?? false });
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
): Promise<{ requestedAt: number; coalesced: boolean }> {
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const now = ctx.clock.now();
  const settings = await getPlatformSettings(ctx);
  const windowMs = settings['refresh.userCooldownSeconds'] * 1000;
  if (!(await claimRefresh(ctx.env.DB, passId, now, windowMs)))
    return { requestedAt: pass.refreshRequestedAt ?? now, coalesced: true };
  await ctx.env.JOBS.send({
    kind: 'pass.refresh',
    passId,
    trigger: actor.type === 'user' ? 'user' : 'admin',
    actorId: actor.id,
  });
  writeEvent(ctx.env, {
    event: 'refresh.requested',
    orgId: pass.orgId,
    templateId: pass.templateId,
  });
  return { requestedAt: now, coalesced: false };
}

export interface ConnectionRecordInput {
  passId: string;
  connectionId: string;
  /** Connection generation at run start; stale runs are fenced. */
  generation: number;
  /** Mapped template inputs. Fields marked `manual` in field_sources are skipped. */
  fields: Personalization;
  holderEmail?: string | null;
  cause: 'connection' | 'user_refresh';
}

/** Applies upstream data; publishes only if the built pass changed. */
export async function applyConnectionRecord(
  ctx: ServiceContext,
  input: ConnectionRecordInput,
): Promise<{ changed: boolean; version: number }> {
  const db = ctx.env.DB;
  const pass = await getPass(db, input.passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (pass.connectionId !== input.connectionId)
    throw new ConflictError(
      'The pass is not linked to this connection.',
      'PASS_CONNECTION_MISMATCH',
    );
  if ((await connectionGeneration(db, input.connectionId)) !== input.generation) {
    ctx.log.info('pass.apply_fenced', { passId: pass.id, connectionId: input.connectionId });
    return { changed: false, version: pass.version };
  }
  const result = await publishPass(ctx, {
    passId: input.passId,
    cause: input.cause,
    actor: { type: 'connection', id: input.connectionId },
    mutate: (current): Mutation => {
      const personalization: Personalization = { ...current.personalization };
      const fieldSources: FieldSources = { ...current.fieldSources };
      for (const [key, value] of Object.entries(input.fields)) {
        if (current.fieldSources[key] === 'manual') continue;
        personalization[key] = value;
        fieldSources[key] = 'connection';
      }
      return { personalization, fieldSources };
    },
  });
  if (result.pass.syncErrorCode) await setSyncError(db, pass.id, null);
  const email = input.holderEmail ? strictEmail(input.holderEmail) : null;
  if (input.holderEmail && !email)
    ctx.log.warn('pass.holder_email_invalid', { passId: pass.id, code: 'EMAIL_INVALID' });
  // Unchanged emails would cost an audit row and hook A on every sync.
  if (email && !result.pass.ownerUserId && email !== result.pass.holderEmail) {
    await assignHolder(
      ctx,
      { type: 'connection', id: input.connectionId },
      { passId: pass.id, email },
      null,
    );
  }
  return { changed: result.changed, version: result.pass.version };
}

export interface CreateFromConnectionInput {
  orgId: string;
  templateId: string;
  connectionId: string;
  externalRef: string;
  fields: Personalization;
  holderEmail?: string | null;
  sendEmail: boolean;
}

/** Idempotent per (connection, externalRef): an existing pass is returned unchanged. */
export async function createPassFromConnection(
  ctx: ServiceContext,
  input: CreateFromConnectionInput,
): Promise<{ passId: string }> {
  const existing = await findByConnectionRef(
    ctx.env.DB,
    input.orgId,
    input.connectionId,
    input.externalRef,
  );
  if (existing) return { passId: existing };
  try {
    const pass = await createPassRow(ctx, {
      orgId: input.orgId,
      templateId: input.templateId,
      input: input.fields,
      holderEmail: input.holderEmail ?? null,
      connectionId: input.connectionId,
      externalRef: input.externalRef,
      sendEmail: input.sendEmail,
      source: 'connection',
      actor: { type: 'connection', id: input.connectionId },
    });
    return { passId: pass.id };
  } catch (error) {
    // A concurrent sync won the unique (connection, ref) index: use its pass, send no email.
    if (!(error instanceof ConflictError) || error.code !== 'PASS_REF_TAKEN') throw error;
    const winner = await findByConnectionRef(
      ctx.env.DB,
      input.orgId,
      input.connectionId,
      input.externalRef,
    );
    if (!winner) throw error;
    return { passId: winner };
  }
}

/** Upstream record missing: `flag` sets sync_error_code RECORD_MISSING; `void` voids the pass. */
export async function markPassMissing(
  ctx: ServiceContext,
  passId: string,
  mode: 'flag' | 'void',
): Promise<void> {
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (mode === 'void' && pass.status === 'active') {
    await publishPass(ctx, {
      passId,
      cause: 'connection',
      actor: { type: 'connection', id: pass.connectionId },
      mutate: () => ({ status: 'voided' }),
    });
  }
  // After the publish, which clears the error column.
  await setSyncError(ctx.env.DB, passId, 'RECORD_MISSING');
}
