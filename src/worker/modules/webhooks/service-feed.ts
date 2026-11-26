import type { z } from 'zod';
import {
  type EventFeedQuerySchema,
  LATEST_WEBHOOK_API_VERSION,
  type WebhookApiVersion,
} from '../../../shared/contracts/webhooks.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fenceOf, type WebhookAccess } from './access.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { buildEnvelope } from './payload.ts';
import { listEventDeliveries } from './repo-event-deliveries.ts';
import { feedHead, getFeedEvent, listFeed } from './repo-feed.ts';

type Query = z.infer<typeof EventFeedQuerySchema>;

const cursorOf = async (ctx: ServiceContext, fence: ReturnType<typeof fenceOf>, seq: number) =>
  `ev2.${await encodeCursor(ctx.env, fence, seq)}`;

/**
 * The tail of the org's event journal, ascending by `seq`. `nextCursor` is never null: the last item's
 * cursor, or the input cursor on an empty page. `after=now` returns no items and the head cursor.
 */
export async function page(ctx: ServiceContext, access: WebhookAccess, q: Query) {
  const fence = fenceOf(access);
  const version: WebhookApiVersion = q.apiVersion ?? LATEST_WEBHOOK_API_VERSION;
  if (q.after === 'now')
    return {
      items: [],
      nextCursor: await cursorOf(ctx, fence, await feedHead(ctx.env.DB, fence)),
      hasMore: false,
    };
  const after = q.after === undefined ? 0 : await decodeCursor(ctx.env, fence, q.after);
  const { rows, hasMore } = await listFeed(ctx.env.DB, fence, {
    after,
    types: q.types,
    passId: q.passId,
    requestId: q.requestId,
    limit: q.limit,
  });
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => buildEnvelope(row, version)),
    nextCursor: await cursorOf(ctx, fence, last ? last.seq : after),
    hasMore,
  };
}

/** One event by ledger id, so a receiver can re-fetch to confirm what a webhook said. */
export async function one(
  ctx: ServiceContext,
  access: WebhookAccess,
  id: string,
  version?: WebhookApiVersion,
) {
  const row = await getFeedEvent(ctx.env.DB, fenceOf(access), id);
  if (!row) throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  return buildEnvelope(row, version ?? LATEST_WEBHOOK_API_VERSION);
}

/** The event's deliveries across endpoints; an event the caller cannot see is not found, never an empty list. */
export async function deliveriesOf(ctx: ServiceContext, access: WebhookAccess, id: string) {
  const fence = fenceOf(access);
  if (!(await getFeedEvent(ctx.env.DB, fence, id)))
    throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  const rows = await listEventDeliveries(ctx.env.DB, fence, id);
  return {
    items: rows.map(({ eventSeq: _seq, type, ...r }) => ({ ...r, type: type as never })),
  };
}
