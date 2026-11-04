import type { Json, Mode } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import type { Job } from '../../jobs/types.ts';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import { getPass } from '../passes/repo.ts';
import {
  bumpCounter,
  insertOutbox,
  listOutboxForPass,
  lostEnqueues,
  markDueEnqueued,
  revertEnqueued,
  touchEnqueued,
} from './repo.ts';

/** Workstream d owns this module. Keep the signatures. */

const SEND_BATCH = 100;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Pass emails per recipient per hour, and per org per day. */
export const EMAIL_RECIPIENT_HOURLY_CAP = 3;
export const EMAIL_ORG_DAILY_CAP = 500;

function message(row: { id: string; kind: 'push' | 'email' }): MessageSendRequest<Job> {
  const kind = row.kind === 'push' ? ('push.deliver' as const) : ('email.send' as const);
  return { body: { kind, outboxId: row.id }, contentType: 'json' };
}

async function sendRows(ctx: ServiceContext, rows: { id: string; kind: 'push' | 'email' }[]) {
  for (let i = 0; i < rows.length; i += SEND_BATCH) {
    await ctx.env.JOBS.sendBatch(rows.slice(i, i + SEND_BATCH).map(message));
  }
}

/**
 * Marks due rows `enqueued`, then sends them. A failed send reverts the mark so the next tick
 * retries; the sweeper covers a crash between the two steps.
 */
export async function dispatchOutbox(
  ctx: ServiceContext,
  options: { passId?: string; limit?: number } = {},
): Promise<number> {
  const rows = await markDueEnqueued(
    ctx.env.DB,
    ctx.clock.now(),
    options.limit ?? 200,
    options.passId,
  );
  if (rows.length === 0) return 0;
  try {
    await sendRows(ctx, rows);
  } catch (error) {
    await revertEnqueued(
      ctx.env.DB,
      rows.map((r) => r.id),
    );
    throw error;
  }
  return rows.length;
}

/** For `waitUntil`: dispatch failures are logged, never thrown into the request. */
export async function dispatchSafely(
  ctx: ServiceContext,
  options: { passId?: string } = {},
): Promise<void> {
  try {
    await dispatchOutbox(ctx, options);
  } catch (error) {
    ctx.log.error('outbox.dispatch_failed', { code: 'OUTBOX_DISPATCH', error });
  }
}

/** Re-sends rows stuck in `enqueued` (message lost after the mark). */
export async function redispatchLost(ctx: ServiceContext, graceMs: number): Promise<number> {
  const now = ctx.clock.now();
  const rows = await lostEnqueues(ctx.env.DB, now - graceMs, 200);
  if (rows.length === 0) return 0;
  await sendRows(ctx, rows);
  await touchEnqueued(
    ctx.env.DB,
    rows.map((r) => r.id),
    now,
  );
  return rows.length;
}

/** Push to every registered device even if the pass didn't change (force refresh catch-up). */
export async function enqueuePush(
  ctx: ServiceContext,
  passId: string,
  reason: 'publish' | 'refresh',
): Promise<void> {
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  await insertOutbox(ctx.env.DB, {
    id: `push:${passId}:${reason}:${ctx.ids.id()}`,
    orgId: pass.orgId,
    kind: 'push',
    passId,
    coalesceKey: `push:${passId}`,
    payload: { reason },
    now: ctx.clock.now(),
  });
  await recordPassEvent(ctx, {
    orgId: pass.orgId,
    passId,
    mode: pass.mode,
    kind: 'push.queued',
    data: { version: pass.version, reason },
  });
  ctx.waitUntil(dispatchSafely(ctx, { passId }));
}

export async function enqueuePassEmail(
  ctx: ServiceContext,
  input: { passId: string; to: string; attach: boolean },
): Promise<{ outboxId: string }> {
  const to = strictEmail(input.to);
  if (!to) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  const pass = await getPass(ctx.env.DB, input.passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return queueEmail(ctx, {
    orgId: pass.orgId,
    passId: pass.id,
    mode: pass.mode,
    to,
    payload: { to, attach: input.attach },
    event: { attached: input.attach },
  });
}

/**
 * Applies the recipient and org caps, then queues one email row, records `email.queued` on the
 * row's pass and dispatches it. Pass and bundle emails share it (`to` is already normalized by
 * `strictEmail`).
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
  },
): Promise<{ outboxId: string }> {
  const now = ctx.clock.now();
  const recipient = (await sha256Hex(`pass-email:${input.to.toLowerCase()}`)).slice(0, 32);
  const perRecipient = await bumpCounter(
    ctx.env.DB,
    `pass-email:to:${recipient}`,
    now - (now % HOUR),
  );
  const perOrg = await bumpCounter(ctx.env.DB, `pass-email:org:${input.orgId}`, now - (now % DAY));
  if (perRecipient > EMAIL_RECIPIENT_HOURLY_CAP || perOrg > EMAIL_ORG_DAILY_CAP)
    throw new AppError('EMAIL_RATE_LIMITED', 429, 'Too many pass emails. Try again later.', {
      headers: { 'retry-after': '3600' },
    });
  const outboxId = ctx.ids.id();
  await insertOutbox(ctx.env.DB, {
    id: outboxId,
    orgId: input.orgId,
    kind: 'email',
    passId: input.passId,
    coalesceKey: null,
    payload: input.payload,
    now: ctx.clock.now(),
  });
  await recordPassEvent(ctx, {
    orgId: input.orgId,
    passId: input.passId,
    mode: input.mode,
    kind: 'email.queued',
    data: { outboxId, ...input.event },
  });
  ctx.waitUntil(dispatchSafely(ctx, { passId: input.passId }));
  return { outboxId };
}

export const listPassDeliveries = (ctx: ServiceContext, passId: string) =>
  listOutboxForPass(ctx.env.DB, passId, 50);
