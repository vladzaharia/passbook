import type { z } from 'zod';
import type { WebhookDeliveryListQuerySchema } from '../../../shared/contracts/webhook-captures.ts';
import type { WebhookReplaySchema } from '../../../shared/contracts/webhooks.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Actor } from '../../platform/context.ts';
import {
  AppError,
  ConflictError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fenceOf, type WebhookAccess } from './access.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { buildEnvelope } from './payload.ts';
import {
  type DeliveryRow,
  type DeliveryState,
  getDelivery,
  hasRecentBulkReplay,
  hasRecentReplayAudit,
  listAttempts,
  listDeliveries,
} from './repo-api.ts';
import type { FeedFence } from './repo-feed.ts';
import {
  backfillDeliveries,
  claimReplayMinute,
  countReplayable,
  missingSeqs,
  replayOne,
  replayWindow,
} from './repo-replay.ts';
import {
  auditEndpoint,
  commitEndpoint,
  notFound,
  requireEndpoint,
  webhookGrant,
} from './service.ts';
import { hostOf } from './url.ts';

type ListQuery = z.infer<typeof WebhookDeliveryListQuerySchema>;
type ReplayInput = z.infer<typeof WebhookReplaySchema>;

/** One bulk replay resets at most this many deliveries. */
export const MAX_REPLAY = 10_000;
const DAY = 86_400_000;
const MIN = 60_000;
/**
 * A backfill reaches back 7 days only: older delivered rows are already purged (retention), so a wider
 * window would send events the endpoint did receive again.
 */
const BACKFILL_DAYS = 7;
/** `inList` takes 20 values; a grant batch of 25 statements covers 500 events. */
const PER_STATEMENT = 20;
const STATEMENTS_PER_GRANT = 25;

const dto = (d: DeliveryRow) => ({
  eventId: d.eventId,
  type: d.type as never,
  passId: d.passId,
  externalId: d.externalId,
  state: d.state,
  attempts: d.attempts,
  nextAt: d.nextAt,
  lastStatus: d.lastStatus,
  lastError: d.lastError,
  lastAttemptAt: d.lastAttemptAt,
  finishedAt: d.finishedAt,
  replays: d.replays,
});

async function seqCursor(
  ctx: ServiceContext,
  fence: FeedFence,
  cursor: string | undefined,
): Promise<number | undefined> {
  if (cursor === undefined) return undefined;
  if (!/^(?:[1-9]\d{0,14}|[A-Za-z0-9_-]{22})$/.test(cursor))
    throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return decodeCursor(ctx.env, fence, cursor);
}

/** Newest first. The cursor is opaque and per tenant (see cursor.ts). */
export async function deliveries(
  ctx: ServiceContext,
  access: WebhookAccess,
  endpointId: string,
  q: ListQuery,
) {
  await requireEndpoint(ctx, access, endpointId);
  const { rows, hasMore } = await listDeliveries(ctx.env.DB, fenceOf(access), endpointId, {
    state: q.state,
    type: q.type,
    requestId: q.requestId,
    passId: q.passId,
    before: await seqCursor(ctx, fenceOf(access), q.cursor),
    limit: q.limit,
  });
  return {
    items: rows.map(dto),
    nextCursor: hasMore
      ? await encodeCursor(ctx.env, fenceOf(access), rows[rows.length - 1]?.eventSeq ?? 0)
      : null,
  };
}

/** The delivery, its attempts and the payload it carries, rebuilt for the endpoint's API version. */
export async function deliveryDetail(
  ctx: ServiceContext,
  access: WebhookAccess,
  endpointId: string,
  eventId: string,
) {
  const endpoint = await requireEndpoint(ctx, access, endpointId);
  const found = await getDelivery(ctx.env.DB, fenceOf(access), endpointId, eventId);
  if (!found) throw notFound();
  const attemptLog = await listAttempts(
    ctx.env.DB,
    fenceOf(access),
    endpointId,
    found.delivery.eventSeq,
  );
  return {
    ...dto(found.delivery),
    attemptLog,
    payload: buildEnvelope(found.feed, endpoint.apiVersion),
  };
}

/** One delivery back to pending with the same event id and body, so receivers dedupe. */
export async function replayDelivery(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  endpointId: string,
  eventId: string,
): Promise<{ queued: number }> {
  const endpoint = await requireEndpoint(ctx, access, endpointId);
  const found = await getDelivery(ctx.env.DB, fenceOf(access), endpointId, eventId);
  if (!found) throw notFound();
  if (found.delivery.state === 'pending')
    throw new ConflictError('This delivery is already waiting to be sent.', 'DELIVERY_PENDING');
  // Per tenant, so a loop over event ids is bounded and cannot be reset by recreating the endpoint.
  const { orgId, mode } = access.authority;
  if (!(await checkRateLimit(ctx.env, 'RL_WEBHOOK_OUT', `replay1:${orgId}:${mode}`)))
    throw new RateLimitedError();
  const g = webhookGrant(ctx, access, 'replay');
  replayOne(g, endpointId, found.delivery.eventSeq);
  // One audit row per endpoint per minute: later single replays inside it are not logged again.
  const now = ctx.clock.now();
  if (!(await hasRecentReplayAudit(ctx.env.DB, orgId, endpointId, now - MIN)))
    auditEndpoint(ctx, g, actor, access, 'webhook.replay', endpointId, {
      host: hostOf(endpoint.url),
      eventId,
      count: 1,
    });
  await commitEndpoint(g);
  return { queued: 1 };
}

const STATES: Record<ReplayInput['include'], DeliveryState[]> = {
  failed: ['failed'],
  failed_and_cancelled: ['failed', 'cancelled'],
  all: ['failed', 'cancelled', 'delivered'],
};

/**
 * Bulk replay by event time: deliveries in the chosen states reset in one statement (at most 10,000),
 * and with `missing` the feed events inside the window that this endpoint never had get a delivery.
 * One per endpoint per minute.
 */
export async function replayRange(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  endpointId: string,
  input: ReplayInput,
): Promise<{ queued: number }> {
  const endpoint = await requireEndpoint(ctx, access, endpointId);
  const fence = fenceOf(access);
  const window = { from: input.from, to: input.to, states: STATES[input.include] };
  const existing = await countReplayable(ctx.env.DB, fence, endpointId, window);
  if (existing > MAX_REPLAY)
    throw new ValidationError(
      `That range holds more than ${MAX_REPLAY} deliveries. Narrow it.`,
      [],
      'REPLAY_TOO_LARGE',
    );
  const seqs = input.missing
    ? await missingSeqs(ctx.env.DB, fence, endpoint, {
        from: Math.max(input.from, ctx.clock.now() - BACKFILL_DAYS * DAY),
        to: input.to,
        limit: MAX_REPLAY + 1,
      })
    : [];
  if (existing + seqs.length > MAX_REPLAY)
    throw new ValidationError(
      `That range holds more than ${MAX_REPLAY} deliveries. Narrow it.`,
      [],
      'REPLAY_TOO_LARGE',
    );

  if (input.dryRun) return { queued: existing + seqs.length };

  // One a minute per org and mode, counted from the committed audit row of the first chunk: a first
  // chunk that fails writes none, so it does not spend the minute.
  if (
    await hasRecentBulkReplay(
      ctx.env.DB,
      access.authority.orgId,
      access.authority.mode,
      ctx.clock.now() - MIN,
    )
  )
    throw new RateLimitedError();

  const plans: ((g: Grant) => GrantedStatement[])[] = [];
  if (existing > 0) plans.push((g) => [replayWindow(g, endpointId, window)]);
  for (let i = 0; i < seqs.length; i += PER_STATEMENT * STATEMENTS_PER_GRANT) {
    const chunk = seqs.slice(i, i + PER_STATEMENT * STATEMENTS_PER_GRANT);
    plans.push((g) => {
      const out: GrantedStatement[] = [];
      for (let j = 0; j < chunk.length; j += PER_STATEMENT)
        out.push(backfillDeliveries(g, endpointId, chunk.slice(j, j + PER_STATEMENT)));
      return out;
    });
  }
  let queued = 0;
  for (const [n, plan] of plans.entries()) {
    const g = webhookGrant(ctx, access, 'replay');
    // The minute is claimed in the first chunk's own batch: of two concurrent replays the batch that
    // runs second finds the first one's audit row and aborts before writing anything.
    if (n === 0) claimReplayMinute(g, ctx.clock.now() - MIN);
    const statements = plan(g);
    if (n === 0)
      auditEndpoint(ctx, g, actor, access, 'webhook.replay', endpointId, {
        host: hostOf(endpoint.url),
        include: input.include,
        from: input.from,
        to: input.to,
        ...(input.missing ? { missing: true } : {}),
      });
    let results: D1Result[];
    try {
      results = await commitEndpoint(g);
    } catch (error) {
      // An earlier chunk is committed and audited: report it instead of failing the whole call.
      if (n === 0) {
        if (error instanceof AppError && error.code === 'STALE') throw new RateLimitedError();
        if (error instanceof AppError) throw error;
        ctx.log.error('webhooks.replay_not_queued', {
          orgId: access.authority.orgId,
          endpointId,
          code: 'REPLAY_NOT_QUEUED',
          error,
        });
        throw new UnavailableError('Nothing was queued. Try again.', 'REPLAY_NOT_QUEUED');
      }
      ctx.log.warn('webhooks.replay_partial', {
        orgId: access.authority.orgId,
        endpointId,
        queued,
        code: 'WEBHOOK_REPLAY_PARTIAL',
        error,
      });
      break;
    }
    for (const s of statements) queued += results[g.indexOf(s)]?.results.length ?? 0;
  }
  return { queued };
}
