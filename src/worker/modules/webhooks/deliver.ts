import type { WebhookEvent } from '../../../shared/contracts/webhooks.ts';
import { type KekRing, loadKekRing } from '../../platform/crypto.ts';
import { batch } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { createSafeFetch, platformHostsOf, type SafeFetch } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sendAllowed } from './deliver-gate.ts';
import { dispatchLane, LANE_HOLD_MS } from './dispatch.ts';
import { bodyOf, buildEnvelope } from './payload.ts';
import {
  type DisabledEndpoint,
  type DueDelivery,
  type LaneKey,
  nextDue,
  overdueEndpoints,
} from './repo-delivery-read.ts';
import {
  attemptStmt,
  captureStmt,
  claimAttempt,
  disableEndpoint,
  endpointFailureStmt,
  endpointSuccessStmt,
  extendLane,
  finishStmt,
  releaseLane,
  rescheduleStmt,
} from './repo-delivery-state.ts';
import { type EndpointRow, getEndpoint } from './repo-endpoints.ts';
import { activeSecrets } from './repo-secrets.ts';
import { resolverFor } from './resolver-memo.ts';
import { CLAIM_HOLD_MS, parseRetryAfter, randomUnit, retryDelay } from './schedule.ts';
import { openSecret } from './secrets.ts';
import { requestHeaders } from './sign.ts';

export const MAX_PER_MESSAGE = 20;
export const SEND_TIMEOUT_MS = 10_000;
/** A message stops taking new deliveries after this much wall time, and hands the rest to a new one. */
export const LANE_WALL_MS = 60_000;
/** After a failed or deferred attempt the lane stays closed this long: a dead endpoint costs one probe, not a stream. */
export const COOL_DOWN_MS = 30_000;
/** Destination-host sends are held back this long when the per-host limit is hit. */
export const HOST_DEFER_MS = 30_000;

export interface LaneJob extends LaneKey {
  lane: string;
}

export type AttemptOutcome =
  | 'delivered'
  | 'retry'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'deferred'
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

/**
 * The secrets this delivery signs with. One that fails to open (a moved row) is skipped, never sent. A
 * missing key ring is a platform fault, not the receiver's: it throws, so the queue retries the message.
 */
async function openSecrets(
  ctx: ServiceContext,
  sender: Sender,
  endpoint: EndpointRow,
  now: number,
): Promise<string[]> {
  const rows = await activeSecrets(ctx.env.DB, endpoint, endpoint.id, now);
  if (rows.length === 0) return [];
  const ring = await sender.ring();
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(
        await openSecret(ring, row.envelope, {
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

/** Disables the given endpoints, each in one batch with its cancel and audit row. */
export async function finalizeDisabled(
  ctx: ServiceContext,
  overdue: readonly DisabledEndpoint[],
): Promise<string[]> {
  const done: string[] = [];
  for (const e of overdue) {
    const host = hostOf(e.url);
    if (!(await disableEndpoint(ctx.env.DB, e, ctx.clock.now(), host))) continue;
    done.push(e.endpointId);
    ctx.log.warn('webhooks.endpoint_disabled', {
      orgId: e.orgId,
      endpointId: e.endpointId,
      host,
      code: 'WEBHOOK_ENDPOINT_DISABLED',
    });
  }
  return done;
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
  if (due.passGone) return cancel('PASS_GONE');
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

  if (!(await sendAllowed(ctx, endpoint, due.sandbox))) {
    await rescheduleStmt(db, k, ctx.clock.now() + HOST_DEFER_MS, null, 'RATE_LIMITED').run();
    return 'deferred';
  }

  const startedAt = ctx.clock.now();
  // The claim is per sender: only one runner can move `attempts` from the value it read, so a duplicate
  // message or a second lane holder never POSTs the same attempt twice.
  if (!(await claimAttempt(db, k, due.attempts, startedAt, CLAIM_HOLD_MS))) return 'skipped';
  const attempt = due.attempts + 1;
  const trigger = attempt === 1 ? (due.replays > 0 ? 'replay' : 'event') : 'retry';

  let status: number | null = null;
  let error: string | null = null;
  let retryAfter: number | null = null;
  let captured: { headers: Record<string, string> } | null = null;
  const secrets = await openSecrets(ctx, sender, endpoint, startedAt);
  if (secrets.length === 0) {
    error = 'SECRET_UNAVAILABLE';
  } else {
    try {
      const headers = await requestHeaders({
        eventId: event.id,
        eventType: event.type,
        secrets,
        nowMs: startedAt,
        body,
      });
      if (endpoint.target === 'capture') {
        // Stored with the attempt below, in one batch. Nothing is sent, so there is no receiver to fail.
        status = 200;
        captured = { headers };
      } else {
        const res = await sender.send(endpoint.url, { method: 'POST', headers, body });
        status = res.status;
        if (status === 429 || status === 503)
          retryAfter = parseRetryAfter(res.headers.get('retry-after'), startedAt);
      }
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
    if (captured)
      statements.push(
        captureStmt(db, k, {
          id: ctx.ids.id(),
          eventId: event.id,
          eventType: event.type,
          trigger: trigger === 'replay' ? 'replay' : 'event',
          headers: captured.headers,
          body,
          durationMs: Math.max(0, now - startedAt),
          at: startedAt,
        }),
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
    // A missing secret is the platform's fault: the attempt is recorded, the endpoint is not blamed.
    if (error !== 'SECRET_UNAVAILABLE') statements.push(endpointFailureStmt(db, k, now));
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
  if (ok || error === 'SECRET_UNAVAILABLE') return outcome;
  // Only this endpoint: the minute sweep disables the rest.
  const mine = await finalizeDisabled(ctx, await overdueEndpoints(db, now, k));
  return mine.length > 0 ? 'disabled' : outcome;
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
      resolver: resolverFor(ctx.env, () => ctx.clock.now()),
    }),
    ring: () => {
      ring ??= loadKekRing(ctx.env);
      return ring;
    },
  };
  const started = ctx.clock.now();
  // The message's token is swapped for a fresh one: a redelivered copy finds it gone and stops.
  let token = job.lane;
  for (let i = 0; i < MAX_PER_MESSAGE; i++) {
    const next = i === 0 ? ctx.ids.token(16) : token;
    // Not ours any more (expired and re-claimed, or the endpoint was disabled): stop quietly.
    if (!(await extendLane(db, lane, token, ctx.clock.now() + LANE_HOLD_MS, next))) return;
    token = next;
    // Re-read each time: a pause, a disable, an edited URL or a changed subscription applies at once.
    const endpoint = await getEndpoint(db, lane, lane.endpointId);
    if (endpoint?.status !== 'active') break;
    const due = await nextDue(db, lane, ctx.clock.now());
    if (!due) break;
    const outcome = await attemptDelivery(ctx, sender, endpoint, due);
    if (outcome === 'disabled') return;
    if (outcome === 'retry' || outcome === 'failed' || outcome === 'deferred') {
      // Circuit open: keep the lane, with no release and no re-dispatch, until the cool-down ends.
      await extendLane(db, lane, token, ctx.clock.now() + COOL_DOWN_MS);
      return;
    }
    if (ctx.clock.now() - started >= LANE_WALL_MS) break;
  }
  await releaseLane(db, lane, token);
  await dispatchLane(ctx, lane);
}
