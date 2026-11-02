import type { Personalization } from '../../../passkit/types.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { deliverPush } from '../delivery/push.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { createPassRow } from './create.ts';
import { detailOf, linksOf, toSummary } from './detail.ts';
import { type Mutation, publishPass } from './publish.ts';
import {
  claimRefresh,
  type FieldSources,
  getPass,
  listPasses,
  pendingPushId,
  setDownloadToken,
  softDeletePass,
} from './repo.ts';

/** Workstream d owns this module; e, f and others call these. Keep the signatures. */
export interface Actor {
  type: 'user' | 'api_key' | 'system' | 'connection';
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
  options: { scope: string | null; ifMatch?: number },
) {
  const changedKeys: string[] = [];
  const result = await publishPass(ctx, {
    passId,
    orgScope: options.scope,
    cause: causeOf(actor),
    actor,
    ...(options.ifMatch !== undefined ? { expectedVersion: options.ifMatch } : {}),
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
  // API keys may not turn resend into a mail relay.
  if (actor.type !== 'user' && to.toLowerCase() !== pass.holderEmail?.toLowerCase())
    throw new ValidationError('Only the holder email can be used.', [], 'RECIPIENT_NOT_HOLDER');
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
): Promise<{ requestedAt: number; coalesced: boolean; cooldownSeconds: number }> {
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const now = ctx.clock.now();
  const settings = await getPlatformSettings(ctx);
  const cooldownSeconds = settings['refresh.userCooldownSeconds'];
  const windowMs = cooldownSeconds * 1000;
  if (!(await claimRefresh(ctx.env.DB, passId, now, windowMs)))
    return { requestedAt: pass.refreshRequestedAt ?? now, coalesced: true, cooldownSeconds };
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
  return { requestedAt: now, coalesced: false, cooldownSeconds };
}

export * from './connection-passes.ts';

/** Throws PASS_NOT_FOUND unless the pass exists inside the scope. */
export async function requirePass(
  ctx: ServiceContext,
  id: string,
  scope: string | null,
): Promise<void> {
  if (!(await getPass(ctx.env.DB, id, scope)))
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
}
