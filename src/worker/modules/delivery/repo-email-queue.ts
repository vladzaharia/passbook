import type { Json } from '../../../shared/contracts/common.ts';
import { type Grant, grant, grantedBatch } from '../../platform/authority.ts';
import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { exists, type GrantCond } from '../../platform/authority-cond.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import { sanitizeEventData } from '../events/record.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import {
  actorOfAuthority,
  DELIVERY_CODES,
  type DeliveryActor,
  deliveryGrant,
} from './delivery-actor.ts';

export interface QueueRate {
  recipientKey: string;
  orgKey: string;
  recipientWindow: number;
  orgWindow: number;
  recipientCap: number;
  orgCap: number;
}

/** Who queues the mail: callers holding live requests, or a durable actor captured earlier. */
export type QueueActors =
  | { request: TenantPassWrite[] }
  | {
      deferred: DeliveryActor[];
      capabilities?: TenantPassWrite[];
      /** The issuance resume on the creating request (see `DeliveryGrantInput`). */
      allowRequestContext?: true;
    };

export type QueueResult = 'queued' | 'limited' | 'stale' | 'org' | 'denied';

const RATE_LIMITED = 'EMAIL_RATE_LIMITED';
const CODES = { ...DELIVERY_CODES, stale: RATE_LIMITED };

/** Both counters are under their cap when the batch runs (a concurrent queue can still lose). */
export function rateChecks(r: QueueRate): Check[] {
  const under = (key: string, window: number, cap: number) =>
    rawCheck(
      'stale',
      'COALESCE((SELECT count FROM counters WHERE key = ? AND window_start = ?), 0) < ?',
      [key, window, cap],
    );
  return [
    under(r.recipientKey, r.recipientWindow, r.recipientCap),
    under(r.orgKey, r.orgWindow, r.orgCap),
  ];
}

/** One grant per actor, sharing codes so they can commit as one batch. The first carries the writes. */
export function queueGrants(
  ctx: ServiceContext,
  actors: QueueActors,
  base: { orgId: string; mode: 'live' | 'test'; checks: Check[]; target: string },
): Grant[] {
  const common = { target: base.target, codes: CODES, tables: QUEUE_TABLES };
  if ('request' in actors)
    return actors.request.map((authority, i) =>
      grant(ctx, {
        ...common,
        purpose: 'org_mode.delivery.email_queue',
        principal: tenantPrincipal(authority),
        checks: [...capabilityChecks(authority), ...(i === 0 ? base.checks : [])],
      }),
    );
  const checks = (i: number) => (i === 0 ? base.checks : []);
  return actors.deferred.map((actor, i) =>
    deliveryGrant(ctx, actor, {
      action: 'email_queue',
      orgId: base.orgId,
      mode: base.mode,
      checks: checks(i),
      ...common,
      ...(actors.allowRequestContext ? { allowRequestContext: true } : {}),
    }),
  );
}

export function authorityActors(
  authority: TenantPassWrite | undefined,
  additional: TenantPassWrite | undefined,
): TenantPassWrite[] {
  return [authority, additional].filter((a): a is TenantPassWrite => a !== undefined);
}

/** The deferred form of captured authorities (the issuance scheduler: no session is consulted). */
export function deferredActors(
  authorities: TenantPassWrite[],
  userRevisions: (number | undefined)[] = [],
): DeliveryActor[] {
  return authorities.map((a, i) => actorOfAuthority(a, userRevisions[i]));
}

/** The audit row is written only while the outbox row it describes is in the batch. */
export function queuedAudit(entry: AuditEntry, outboxId: string): NonNullable<QueueWrite['audit']> {
  return { entry, when: [exists('outbox', { id: outboxId })] };
}

/** What a queued email writes: the outbox row, its counters and the event. */
const QUEUE_TABLES = ['outbox', 'counters', 'pass_events', 'pass_issuance_deliveries'] as const;

export interface QueueWrite {
  id: string;
  passId: string;
  payload: Record<string, unknown>;
  now: number;
  rate: QueueRate;
  audit?: { entry: AuditEntry; when?: GrantCond[] };
}

/**
 * The outbox row, both counters, the `email.queued` event and an optional audit row: one batch with
 * the grant, so the mail exists exactly when its authority held and every counter moved with it.
 */
export function addQueueWrites(g: Grant, ctx: ServiceContext, w: QueueWrite): void {
  g.insertSelect(
    'outbox',
    ['id', 'kind', 'pass_id', 'coalesce_key', 'payload', 'state', 'available_at', 'created_at'],
    [w.id, 'email', w.passId, null, JSON.stringify(w.payload), 'pending', 0, w.now],
    { returning: ['id'] },
  );
  for (const [key, window] of [
    [w.rate.recipientKey, w.rate.recipientWindow],
    [w.rate.orgKey, w.rate.orgWindow],
  ] as const)
    g.add(
      g.unguarded(
        `INSERT INTO counters (key, window_start, count)
          SELECT ?, ?, 1 FROM authority_grants g WHERE g.id = ?
          ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1`,
        [key, window, g.id],
      ),
    );
  if (w.audit) g.add(grantedAudit(g, ctx, w.audit.entry, w.audit.when));
}

/** Commits the grants as one batch and maps a refusal to the result callers already handle. */
export async function commitQueue(ctx: ServiceContext, grants: Grant[]): Promise<QueueResult> {
  try {
    await grantedBatch(ctx.env.DB, grants);
    return 'queued';
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === RATE_LIMITED) return 'limited';
      if (error.code === 'DELIVERY_STALE') return 'stale';
      if (error.code === 'ORG_ACCESS_CHANGED') return 'org';
      if (error.status === 403) return 'denied';
    }
    throw error;
  }
}

/**
 * The `email.queued` ledger entry. It is best effort and a separate grant: the mail stays queued if
 * the ledger fails or the actor lost authority since the queueing batch (nothing is then recorded).
 */
export async function recordQueuedEvent(
  ctx: ServiceContext,
  actors: QueueActors,
  e: {
    orgId: string;
    mode: 'live' | 'test';
    passId: string;
    outboxId: string;
    data: Record<string, Json>;
  },
): Promise<void> {
  try {
    const grants = queueGrants(ctx, actors, {
      orgId: e.orgId,
      mode: e.mode,
      checks: [rowIs('passes', e.passId)],
      target: e.passId,
    });
    const now = ctx.clock.now();
    grants[0]?.insertSelect(
      'pass_events',
      ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
      [
        ctx.ids.ordered(now),
        e.passId,
        'email.queued',
        null,
        null,
        null,
        JSON.stringify(sanitizeEventData({ outboxId: e.outboxId, ...e.data })),
        now,
      ],
    );
    await grantedBatch(ctx.env.DB, grants);
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      ctx.log.info('events.skipped', {
        code: 'EVENT_SKIPPED',
        kind: 'email.queued',
        reason: error.code,
      });
      return;
    }
    ctx.log.error('events.record_failed', {
      code: 'EVENT_RECORD_FAILED',
      count: 1,
      kind: 'email.queued',
      passId: e.passId,
      error,
    });
  }
}
