import type { Json, Mode } from '../../../shared/contracts/common.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { BundleEmailSnapshot } from '../bundles/email-binding.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import {
  authorityMayQueue,
  captureActor,
  type DeliveryActor,
  systemActor,
} from './delivery-actor.ts';
import {
  dispatchSafely,
  EMAIL_ORG_DAILY_CAP,
  EMAIL_RECIPIENT_HOURLY_CAP,
} from './issuance-intent.ts';
import { enqueueAuthorizedEmail, listAuthorizedOutboxForPass } from './repo.ts';
import { queuedAudit } from './repo-email-queue.ts';
import { insertPushOutbox, recordPushQueuedEvent } from './repo-outbox-enqueue.ts';
import { insertRefreshPush, type RefreshPushContext } from './repo-outbox-refresh.ts';

/** Workstream d owns this module. Keep the signatures. */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Push to every registered device even if the pass didn't change (force refresh catch-up). */
export async function enqueuePush(
  ctx: ServiceContext,
  passId: string,
  reason: 'publish' | 'refresh',
): Promise<void> {
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const queued = await insertPushOutbox(ctx, {
    id: `push:${passId}:${reason}:${ctx.ids.id()}`,
    orgId: pass.orgId,
    mode: pass.mode,
    passId,
    identityId: pass.identityId,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    coalesceKey: `push:${JSON.stringify([
      passId,
      pass.identityId,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      pass.templateId,
      pass.templateVersion,
      pass.releaseId,
    ])}`,
    payload: {
      reason,
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      releaseId: pass.releaseId,
    },
    now: ctx.clock.now(),
  });
  if (queued === 'stale') throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  await recordPushQueuedEvent(ctx, {
    orgId: pass.orgId,
    passId,
    mode: pass.mode,
    identityId: pass.identityId,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    passVersion: pass.version,
    reason,
  });
  ctx.waitUntil(dispatchSafely(ctx, { passId }));
}

/** Commit the refresh against the captured pass/connection state before scheduling a push. */
export async function enqueueRefreshPush(
  ctx: ServiceContext,
  snapshot: RefreshPushContext,
): Promise<boolean> {
  if (
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== snapshot.credentialKeysetCommitment
  )
    return false;
  const queued = await insertRefreshPush(
    ctx,
    snapshot,
    `push:${snapshot.passId}:refresh:${ctx.ids.id()}`,
    ctx.clock.now(),
  );
  if (!queued) return false;
  await recordPushQueuedEvent(ctx, { ...snapshot, reason: 'refresh' });
  ctx.waitUntil(dispatchSafely(ctx, { passId: snapshot.passId }));
  return true;
}

/**
 * Applies the recipient and org caps, then queues one email row, records `email.queued` on the
 * row's pass and dispatches it. Pass and bundle emails share it (`to` is already normalized by
 * `strictEmail`). The actor is the live request's authority, or a job acting for the system.
 */
export async function queueEmail(
  ctx: ServiceContext,
  input: {
    orgId: string;
    passId: string;
    mode: Mode;
    to: string;
    payload: Record<string, unknown>;
    event: Record<string, Json>;
    authority?: TenantPassWrite;
    bundleSnapshot?: BundleEmailSnapshot;
    /** Recorded in the same batch as the mail. */
    auditEntry?: AuditEntry;
  },
): Promise<{ outboxId: string }> {
  if (
    (typeof input.payload.bundleId === 'string' || input.bundleSnapshot) &&
    (!input.bundleSnapshot || input.payload.bundleId !== input.bundleSnapshot.bundle.id)
  )
    throw new ConflictError(
      'The bundle changed. Review the recipient and try again.',
      'DELIVERY_STALE',
    );
  const { authority } = input;
  if (authority && !authorityMayQueue(authority, input)) throw new ForbiddenError();
  const actor: DeliveryActor = authority
    ? await captureActor(ctx.env.DB, authority)
    : await systemActor(ctx.env.DB, input.orgId);
  const intent = input.payload.intent;
  const payload =
    intent && typeof intent === 'object'
      ? { ...input.payload, intent: { ...intent, actor } }
      : input.payload;
  // Captured test mail has its own counters: it must not use up the caps of real holder email.
  const recipient = (await sha256Hex(`pass-email:${input.to.toLowerCase()}`)).slice(0, 32);
  const now = ctx.clock.now();
  const outboxId = ctx.ids.id();
  const result = await enqueueAuthorizedEmail(ctx, {
    orgId: input.orgId,
    passId: input.passId,
    mode: input.mode,
    payload,
    event: input.event,
    actors: authority ? { request: [authority] } : { deferred: [actor] },
    ...(input.bundleSnapshot ? { bundleSnapshot: input.bundleSnapshot } : {}),
    ...(input.auditEntry ? { audit: queuedAudit(input.auditEntry, outboxId) } : {}),
    outboxId,
    rate: {
      recipientKey: `pass-email:${input.mode}:to:${recipient}`,
      orgKey: `pass-email:${input.mode}:org:${input.orgId}`,
      recipientWindow: now - (now % HOUR),
      orgWindow: now - (now % DAY),
      recipientCap: EMAIL_RECIPIENT_HOURLY_CAP,
      orgCap: EMAIL_ORG_DAILY_CAP,
    },
  });
  if (result === 'org')
    throw new ForbiddenError(
      'Organization access changed. Reload and retry.',
      'ORG_ACCESS_CHANGED',
    );
  if (result === 'denied') throw new ForbiddenError();
  if (result === 'stale')
    throw new ConflictError(
      'The bundle changed. Review the recipient and try again.',
      'DELIVERY_STALE',
    );
  if (result === 'limited')
    throw new AppError('EMAIL_RATE_LIMITED', 429, 'Too many pass emails. Try again later.', {
      headers: { 'retry-after': '3600' },
    });
  ctx.waitUntil(dispatchSafely(ctx, { passId: input.passId }));
  return { outboxId };
}

export const listPassDeliveries = (
  ctx: ServiceContext,
  passId: string,
  authority: TenantPassWrite,
) => listAuthorizedOutboxForPass(ctx.env.DB, passId, authority, ctx.clock.now());
