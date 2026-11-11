import { retryDelaySeconds } from '../../jobs/retry.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PassEventInput } from '../events/record.ts';
import { isOrgActive } from '../orgs/active.ts';
import { depsOf } from '../passes/deps.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { ApnsResult } from './apns.ts';
import { pushEvent, recordPushEvents } from './push-events.ts';
import {
  type DeviceTarget,
  deliveredDevices,
  devicesForPass,
  dropRegistrations,
  finishCurrentPush,
  type PushFence,
  type PushResultRow,
  pushPassCurrent,
  releaseCurrentPush,
  savePushResults,
  setApnsHealth,
} from './repo.ts';
import type { OutboxRow } from './repo-outbox-map.ts';
import {
  claimOutbox,
  failExhausted,
  finishOutbox,
  releaseOutbox,
} from './repo-outbox-processing.ts';

export const LEASE_MS = 5 * 60_000;

/** Thrown so the queue retries the message with backoff. */
export class TransientDeliveryError extends AppError {
  constructor(code: string) {
    super(code, 503, 'Delivery failed. It will be retried.');
  }
}

const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);
const CERT_REASONS = new Set([
  'BadCertificate',
  'BadCertificateEnvironment',
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'PushKeyUnreadable',
  'MissingTopic',
  'TopicDisallowed',
  'Forbidden',
]);

export type PushOutcome = 'ok' | 'gone' | 'transient' | 'cert' | 'rejected';

export function classifyApns(result: ApnsResult): PushOutcome {
  if (result.status === 200) return 'ok';
  if (result.status === 410 || DEAD_TOKEN_REASONS.has(result.reason ?? '')) return 'gone';
  if (result.status === 403 || CERT_REASONS.has(result.reason ?? '')) return 'cert';
  if (result.status === 429 || result.status >= 500 || result.status === 0) return 'transient';
  return 'rejected';
}

/**
 * Claims a row for this consumer. When the claim fails the message is a duplicate or the row is
 * exhausted: an exhausted row is failed, anything else is left to its current owner.
 */
export async function claimOrSettle(
  ctx: ServiceContext,
  outboxId: string,
): Promise<{ row: OutboxRow; lease: string } | null> {
  const lease = ctx.ids.token(8);
  const row = await claimOutbox(ctx.env.DB, outboxId, lease, ctx.clock.now(), LEASE_MS);
  if (row) return { row, lease };
  // Another consumer may hold the row or have just released it for a retry: only an
  // exhausted row is failed, in one guarded statement.
  if (await failExhausted(ctx.env.DB, outboxId, ctx.clock.now()))
    ctx.log.warn('outbox.exhausted', { outboxId, code: 'MAX_ATTEMPTS' });
  return null;
}

/** Either finishes the row (last attempt) or releases it and throws for Queue retry. */
export async function retryOrGiveUp(
  ctx: ServiceContext,
  row: OutboxRow,
  lease: string,
  code: string,
  finalState: 'partial' | 'failed',
): Promise<void> {
  const now = ctx.clock.now();
  if (row.attempts >= row.maxAttempts) {
    await finishOutbox(ctx.env.DB, row.id, lease, finalState, now, code);
    return;
  }
  const delay = retryDelaySeconds(row.attempts) * 1000;
  await releaseOutbox(ctx.env.DB, row.id, lease, now + delay, code);
  throw new TransientDeliveryError(code);
}

async function settleCurrentPush(
  ctx: ServiceContext,
  fence: PushFence,
  state: 'sent' | 'partial' | 'failed' | 'cancelled',
  code: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  if (!(await finishCurrentPush(ctx.env.DB, fence, state, now, code)))
    await finishOutbox(ctx.env.DB, fence.outboxId, fence.lease, 'cancelled', now, 'PASS_GONE');
}

async function retryCurrentPush(
  ctx: ServiceContext,
  row: OutboxRow,
  fence: PushFence,
  code: string,
  finalState: 'partial' | 'failed',
): Promise<void> {
  if (row.attempts >= row.maxAttempts) return settleCurrentPush(ctx, fence, finalState, code);
  const now = ctx.clock.now();
  if (
    await releaseCurrentPush(ctx.env.DB, fence, now + retryDelaySeconds(row.attempts) * 1000, code)
  )
    throw new TransientDeliveryError(code);
  await finishOutbox(ctx.env.DB, fence.outboxId, fence.lease, 'cancelled', now, 'PASS_GONE');
}

export async function deliverPush(ctx: ServiceContext, outboxId: string): Promise<void> {
  const db = ctx.env.DB;
  const claimed = await claimOrSettle(ctx, outboxId);
  if (!claimed) return;
  const { row, lease } = claimed;
  const now = ctx.clock.now();
  const pass = row.passId ? await getPass(db, row.passId) : null;
  if (!pass) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'PASS_GONE');
    return;
  }
  if (
    row.orgId !== pass.orgId ||
    row.payload.identityId !== pass.identityId ||
    row.payload.credentialGeneration !== pass.credentialGeneration ||
    row.payload.lifecycleGeneration !== pass.lifecycleGeneration ||
    row.payload.templateId !== pass.templateId ||
    row.payload.templateVersion !== pass.templateVersion ||
    row.payload.releaseId !== pass.releaseId
  ) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'PASS_GONE');
    return;
  }
  const fence: PushFence = {
    passId: pass.id,
    orgId: pass.orgId,
    identityId: pass.identityId,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    outboxId: row.id,
    lease,
  };
  if (!(await isOrgActive(ctx, pass.orgId))) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'ORG_INACTIVE');
    return;
  }
  const deps = depsOf(ctx.env);
  const identity = await deps.identities.byId(pass.identityId).catch((error: unknown) => {
    if (!(error instanceof NotFoundError)) throw error;
    return null;
  });
  if (!identity) {
    if (await pushPassCurrent(db, fence))
      ctx.log.error('push.identity_missing', { passId: pass.id, code: 'IDENTITY_MISSING' });
    await settleCurrentPush(ctx, fence, 'failed', 'IDENTITY_MISSING');
    return;
  }
  const target = {
    passTypeIdentifier: identity.passTypeIdentifier,
    apnsBinding: identity.apnsBinding,
    teamIdentifier: identity.teamIdentifier,
  };
  if (!(await deps.apns.isAvailable(target))) {
    if (!(await pushPassCurrent(db, fence))) {
      await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'PASS_GONE');
      return;
    }
    await recordPushEvents(ctx, fence, [
      pushEvent(pass, 'push.failed', { code: 'PUSH_UNAVAILABLE', version: pass.version }),
    ]);
    await settleCurrentPush(ctx, fence, 'cancelled', 'PUSH_UNAVAILABLE');
    return;
  }

  const registered = await devicesForPass(db, pass.id, pass.identityId, pass.credentialGeneration);
  // Nothing to reach: not "sent" (the delivery list would claim a device got it).
  if (registered.length === 0) {
    await settleCurrentPush(ctx, fence, 'cancelled', 'NO_DEVICES');
    return;
  }
  const delivered = await deliveredDevices(db, row.id);
  const devices = registered.filter((d) => !delivered.has(d.deviceId));
  if (devices.length === 0) {
    await settleCurrentPush(ctx, fence, 'sent', null);
    return;
  }

  const byToken = new Map<string, DeviceTarget[]>();
  for (const device of devices) {
    const group = byToken.get(device.pushToken);
    if (group) group.push(device);
    else byToken.set(device.pushToken, [device]);
  }
  if (!(await pushPassCurrent(db, fence))) {
    await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'PASS_GONE');
    return;
  }
  const results = await deps.apns.send(target, [...byToken.keys()], now);
  if (!(await pushPassCurrent(db, fence))) {
    await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'PASS_GONE');
    return;
  }

  const events: PassEventInput[] = [];
  const saved: PushResultRow[] = [];
  const gone: DeviceTarget[] = [];
  const count: Record<PushOutcome, number> = { ok: 0, gone: 0, transient: 0, cert: 0, rejected: 0 };
  for (const result of results) {
    const outcome = classifyApns(result);
    for (const device of byToken.get(result.token) ?? []) {
      count[outcome]++;
      saved.push({
        deviceId: device.deviceId,
        pushToken: device.pushToken,
        httpStatus: result.status,
        reason: result.reason ?? null,
        apnsId: result.apnsId ?? null,
      });
      const ok = outcome === 'ok';
      events.push({
        ...pushEvent(pass, ok ? 'push.sent' : 'push.failed', {
          version: pass.version,
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          outcome,
        }),
        device: device.deviceId,
      });
      if (outcome === 'gone') {
        events.push({
          ...pushEvent(pass, 'device.unregistered', { reason: 'push_gone' }),
          device: device.deviceId,
        });
        gone.push(device);
      }
    }
    writeEvent(ctx.env, {
      event: 'push.result',
      orgId: pass.orgId,
      templateId: pass.templateId,
      identityId: pass.identityId,
      outcome: outcome === 'ok' ? 'ok' : `${result.status}:${result.reason ?? ''}`,
      mode: pass.mode,
    });
  }
  await savePushResults(db, fence, saved, now);
  await recordPushEvents(ctx, fence, events);
  if (gone.length) await dropRegistrations(db, fence, gone);
  if (count.cert > 0) await setApnsHealth(db, fence, 'failing');
  else if (count.ok > 0) await setApnsHealth(db, fence, 'healthy');

  if (count.cert > 0)
    return retryCurrentPush(
      ctx,
      row,
      fence,
      'APNS_CERT',
      count.ok + delivered.size ? 'partial' : 'failed',
    );
  if (count.transient > 0)
    return retryCurrentPush(
      ctx,
      row,
      fence,
      'APNS_TRANSIENT',
      count.ok + count.gone + delivered.size ? 'partial' : 'failed',
    );
  if (count.rejected > 0) {
    const state = count.ok + count.gone + delivered.size > 0 ? 'partial' : 'failed';
    await settleCurrentPush(ctx, fence, state, 'APNS_REJECTED');
    return;
  }
  await settleCurrentPush(ctx, fence, 'sent', null);
}
