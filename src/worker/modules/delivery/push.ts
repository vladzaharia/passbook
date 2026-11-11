import { retryDelaySeconds } from '../../jobs/retry.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type PassEventInput, recordPassEvents } from '../events/record.ts';
import { isOrgActive } from '../orgs/active.ts';
import { depsOf } from '../passes/deps.ts';
import { getPass } from '../passes/repo.ts';
import type { ApnsResult } from './apns.ts';
import {
  claimOutbox,
  type DeviceTarget,
  deliveredDevices,
  devicesForPass,
  dropRegistrations,
  failExhausted,
  finishOutbox,
  type OutboxRow,
  type PushResultRow,
  pushPassCurrent,
  releaseOutbox,
  savePushResults,
  setApnsHealth,
} from './repo.ts';

function pushEvent(
  pass: { id: string; orgId: string; mode: 'live' | 'test' },
  kind: 'push.sent' | 'push.failed' | 'device.unregistered',
  data: Record<string, string | number>,
): PassEventInput {
  return { orgId: pass.orgId, passId: pass.id, mode: pass.mode, kind, data };
}

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
  if (!(await isOrgActive(ctx, pass.orgId))) {
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'ORG_INACTIVE');
    return;
  }
  const deps = depsOf(ctx.env);
  const identity = await deps.identities.byId(pass.identityId).catch(async (error: unknown) => {
    if (!(error instanceof NotFoundError)) throw error;
    ctx.log.error('push.identity_missing', { passId: pass.id, code: 'IDENTITY_MISSING' });
    return null;
  });
  if (!identity) {
    await finishOutbox(db, row.id, lease, 'failed', now, 'IDENTITY_MISSING');
    return;
  }
  const target = {
    passTypeIdentifier: identity.passTypeIdentifier,
    apnsBinding: identity.apnsBinding,
    teamIdentifier: identity.teamIdentifier,
  };
  if (!(await deps.apns.isAvailable(target))) {
    if (!(await pushPassCurrent(db, pass.id, pass.orgId, pass.identityId))) {
      await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'PASS_GONE');
      return;
    }
    await recordPassEvents(ctx, [
      pushEvent(pass, 'push.failed', { code: 'PUSH_UNAVAILABLE', version: pass.version }),
    ]);
    await finishOutbox(db, row.id, lease, 'cancelled', now, 'PUSH_UNAVAILABLE');
    return;
  }

  const registered = await devicesForPass(db, pass.id, pass.identityId);
  // Nothing to reach: not "sent" (the delivery list would claim a device got it).
  if (registered.length === 0) {
    const current = await pushPassCurrent(db, pass.id, pass.orgId, pass.identityId);
    await finishOutbox(db, row.id, lease, 'cancelled', now, current ? 'NO_DEVICES' : 'PASS_GONE');
    return;
  }
  const delivered = await deliveredDevices(db, row.id);
  const devices = registered.filter((d) => !delivered.has(d.deviceId));
  if (devices.length === 0) {
    await finishOutbox(db, row.id, lease, 'sent', now, null);
    return;
  }

  const byToken = new Map<string, DeviceTarget[]>();
  for (const d of devices) byToken.set(d.pushToken, [...(byToken.get(d.pushToken) ?? []), d]);
  if (!(await pushPassCurrent(db, pass.id, pass.orgId, pass.identityId))) {
    await finishOutbox(db, row.id, lease, 'cancelled', ctx.clock.now(), 'PASS_GONE');
    return;
  }
  const results = await deps.apns.send(target, [...byToken.keys()], now);

  const events: PassEventInput[] = [];
  const saved: PushResultRow[] = [];
  const gone: { deviceId: string; pushToken: string }[] = [];
  const count: Record<PushOutcome, number> = { ok: 0, gone: 0, transient: 0, cert: 0, rejected: 0 };
  for (const result of results) {
    const outcome = classifyApns(result);
    for (const device of byToken.get(result.token) ?? []) {
      count[outcome]++;
      saved.push({
        deviceId: device.deviceId,
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
        gone.push({ deviceId: device.deviceId, pushToken: device.pushToken });
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
  await savePushResults(db, row.id, saved, now);
  await recordPassEvents(ctx, events);
  if (gone.length) await dropRegistrations(db, pass.identityId, gone);
  if (count.cert > 0) await setApnsHealth(db, pass.identityId, 'failing');
  else if (count.ok > 0) await setApnsHealth(db, pass.identityId, 'healthy');

  if (count.cert > 0)
    return retryOrGiveUp(
      ctx,
      row,
      lease,
      'APNS_CERT',
      count.ok + delivered.size ? 'partial' : 'failed',
    );
  if (count.transient > 0)
    return retryOrGiveUp(
      ctx,
      row,
      lease,
      'APNS_TRANSIENT',
      count.ok + count.gone + delivered.size ? 'partial' : 'failed',
    );
  if (count.rejected > 0) {
    const state = count.ok + count.gone + delivered.size > 0 ? 'partial' : 'failed';
    await finishOutbox(db, row.id, lease, state, now, 'APNS_REJECTED');
    return;
  }
  await finishOutbox(db, row.id, lease, 'sent', now, null);
}
