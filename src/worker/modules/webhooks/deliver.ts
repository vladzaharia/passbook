import type { WebhookEvent } from '../../../shared/contracts/webhooks.ts';
import { type KekRing, loadKekRing } from '../../platform/crypto.ts';
import { batch } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { createSafeFetch, platformHostsOf, type SafeFetch } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { dispatchLane, LANE_HOLD_MS } from './dispatch.ts';
import { bodyOf, buildEnvelope } from './payload.ts';
import {
  attemptStmt,
  cancelPendingStmt,
  claimAttempt,
  type DisabledEndpoint,
  type DueDelivery,
  disableOverdue,
  endpointFailureStmt,
  endpointSuccessStmt,
  extendLane,
  finishStmt,
  type LaneKey,
  nextDue,
  releaseLane,
  rescheduleStmt,
} from './repo-delivery-state.ts';
import { type EndpointRow, getEndpoint } from './repo-endpoints.ts';
import { activeSecrets } from './repo-secrets.ts';
import { memoResolver } from './resolver-memo.ts';
import { CLAIM_HOLD_MS, parseRetryAfter, randomUnit, retryDelay } from './schedule.ts';
import { openSecret } from './secrets.ts';
import { requestHeaders } from './sign.ts';

export const MAX_PER_MESSAGE = 20;
export const SEND_TIMEOUT_MS = 10_000;

export interface LaneJob extends LaneKey {
  lane: string;
}

export type AttemptOutcome =
  | 'delivered'
  | 'retry'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'disabled';

interface Sender {
  send: SafeFetch;
  ring: () => Promise<KekRing>;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
};

/** The secrets this delivery signs with. One that fails to open (a moved row) is skipped, never sent. */
async function openSecrets(
  ctx: ServiceContext,
  sender: Sender,
  endpoint: EndpointRow,
  now: number,
): Promise<string[]> {
  const rows = await activeSecrets(ctx.env.DB, endpoint, endpoint.id, now);
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(
        await openSecret(await sender.ring(), row.envelope, {
          secretId: row.id,
          orgId: endpoint.orgId,
          endpointId: endpoint.id,
          mode: endpoint.mode,
        }),
      );
    } catch {
      ctx.log.error('webhooks.secret_unavailable', {
        orgId: endpoint.orgId,
        endpointId: endpoint.id,
        code: 'SECRET_UNAVAILABLE',
      });
    }
  }
  return out;
}

/** An endpoint that has failed for 72 h: its pending deliveries are cancelled and an audit row is written. */
export async function finalizeDisabled(
  ctx: ServiceContext,
  disabled: readonly DisabledEndpoint[],
): Promise<void> {
  const db = ctx.env.DB;
  for (const e of disabled) {
    const host = hostOf(e.url);
    await batch(db, [
      cancelPendingStmt(db, e, ctx.clock.now(), 'ENDPOINT_DISABLED'),
      auditStmt(db, ctx, {
        orgId: e.orgId,
        actorType: 'system',
        action: 'webhook.endpoint_disabled',
        targetType: 'webhook_endpoint',
        targetId: e.endpointId,
        detail: { endpointId: e.endpointId, host, failingSince: e.failingSince },
      }),
    ]);
    ctx.log.warn('webhooks.endpoint_disabled', {
      orgId: e.orgId,
      endpointId: e.endpointId,
      host,
      code: 'WEBHOOK_ENDPOINT_DISABLED',
    });
  }
}

/**
 * One attempt at one due delivery: re-check, build, assert the tenant, sign, POST, record. Endpoint
 * failures are state, never thrown; only D1 errors throw, and the queue then retries the message.
 */
export async function attemptDelivery(
  ctx: ServiceContext,
  sender: Sender,
  endpoint: EndpointRow,
  due: DueDelivery,
): Promise<AttemptOutcome> {
  const db = ctx.env.DB;
  const k = due.key;
  const log = { orgId: endpoint.orgId, endpointId: endpoint.id };
  const cancel = async (reason: string): Promise<AttemptOutcome> => {
    await finishStmt(db, k, 'cancelled', ctx.clock.now(), null, reason).run();
    return 'cancelled';
  };

  // Send-time re-checks: the endpoint, org and pass may have changed since the event was written.
  const { feed } = due;
  if (
    !endpoint.eventTypes.includes(feed.type) ||
    (endpoint.templateIds !== null && !endpoint.templateIds.includes(feed.templateId))
  )
    return cancel('UNSUBSCRIBED');
  if (!due.orgActive) return cancel('ORG_INACTIVE');
  if (due.quarantined) return cancel('PASS_QUARANTINED');

  let event: WebhookEvent;
  let body: string;
  try {
    event = buildEnvelope(feed, endpoint.apiVersion);
    body = bodyOf(event);
  } catch {
    ctx.log.error('webhooks.payload_invalid', { ...log, code: 'WEBHOOK_PAYLOAD_INVALID' });
    return cancel('PAYLOAD_INVALID');
  }
  if (
    feed.orgId !== endpoint.orgId ||
    feed.mode !== endpoint.mode ||
    event.orgId !== endpoint.orgId ||
    event.mode !== endpoint.mode
  ) {
    ctx.log.error('webhooks.tenant_mismatch', { ...log, code: 'WEBHOOK_TENANT_MISMATCH' });
    return cancel('WEBHOOK_TENANT_MISMATCH');
  }

  const startedAt = ctx.clock.now();
  if (!(await claimAttempt(db, k, due.attempts, startedAt, CLAIM_HOLD_MS))) return 'skipped';
  const attempt = due.attempts + 1;
  const trigger = attempt === 1 ? (due.replays > 0 ? 'replay' : 'event') : 'retry';

  let status: number | null = null;
  let error: string | null = null;
  let retryAfter: number | null = null;
  const secrets = await openSecrets(ctx, sender, endpoint, startedAt);
  if (secrets.length === 0) {
    error = 'SECRET_UNAVAILABLE';
  } else {
    try {
      const res = await sender.send(endpoint.url, {
        method: 'POST',
        headers: await requestHeaders({
          eventId: event.id,
          eventType: event.type,
          secrets,
          nowMs: startedAt,
          body,
        }),
        body,
      });
      status = res.status;
      if (status === 429 || status === 503)
        retryAfter = parseRetryAfter(res.headers.get('retry-after'), startedAt);
    } catch (e) {
      error = e instanceof AppError && /^[A-Z][A-Z0-9_]{1,39}$/.test(e.code) ? e.code : 'UPSTREAM';
    }
  }

  const now = ctx.clock.now();
  const ok = status !== null && status >= 200 && status < 300;
  const statements = [
    attemptStmt(db, k, {
      id: ctx.ids.id(),
      attempt,
      trigger,
      status,
      errorCode: error,
      durationMs: Math.max(0, now - startedAt),
      at: startedAt,
    }),
  ];
  let outcome: AttemptOutcome;
  if (ok) {
    outcome = 'delivered';
    statements.push(
      finishStmt(db, k, 'delivered', now, status, null),
      endpointSuccessStmt(db, k, now),
    );
  } else {
    const delay = retryDelay(attempt, randomUnit(), retryAfter);
    if (delay === null) {
      outcome = 'failed';
      statements.push(finishStmt(db, k, 'failed', now, status, error));
    } else {
      outcome = 'retry';
      statements.push(rescheduleStmt(db, k, now + delay, status, error));
    }
    statements.push(endpointFailureStmt(db, k, now));
  }
  await batch(db, statements);
  ctx.log.info('webhooks.attempt', {
    ...log,
    host: hostOf(endpoint.url),
    status,
    code: error ?? undefined,
    attempt,
    outcome,
  });
  if (ok) return outcome;
  const disabled = await disableOverdue(db, now);
  await finalizeDisabled(ctx, disabled);
  return disabled.some((d) => d.endpointId === endpoint.id) ? 'disabled' : outcome;
}

/**
 * The `webhook.deliver` handler: up to 20 due deliveries of one endpoint, in order, then the lane is
 * released and, while more are due, claimed again and re-enqueued.
 */
export async function runLane(
  ctx: ServiceContext,
  job: LaneJob,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<void> {
  const db = ctx.env.DB;
  const lane: LaneKey = { endpointId: job.endpointId, orgId: job.orgId, mode: job.mode };
  let ring: Promise<KekRing> | undefined;
  const sender: Sender = {
    send: createSafeFetch({
      platformHosts: platformHostsOf(ctx.env),
      timeoutMs,
      discardBody: true,
      resolver: memoResolver(() => ctx.clock.now()),
    }),
    ring: () => {
      ring ??= loadKekRing(ctx.env);
      return ring;
    },
  };
  for (let i = 0; i < MAX_PER_MESSAGE; i++) {
    // Not ours any more (expired and re-claimed, or the endpoint was disabled): stop quietly.
    if (!(await extendLane(db, lane, job.lane, ctx.clock.now() + LANE_HOLD_MS))) return;
    // Re-read each time: a pause, a disable, an edited URL or a changed subscription applies at once.
    const endpoint = await getEndpoint(db, lane, lane.endpointId);
    if (endpoint?.status !== 'active') break;
    const due = await nextDue(db, lane, ctx.clock.now());
    if (!due) break;
    if ((await attemptDelivery(ctx, sender, endpoint, due)) === 'disabled') break;
  }
  await releaseLane(db, lane, job.lane);
  await dispatchLane(ctx, lane);
}
