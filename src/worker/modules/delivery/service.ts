import { strictEmail } from '../../../shared/email.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPass } from '../passes/repo.ts';
import {
  insertOutbox,
  lostEnqueues,
  markDueEnqueued,
  revertEnqueued,
  touchEnqueued,
} from './repo.ts';

/** Workstream d owns this module. Keep the signatures. */

const SEND_BATCH = 100;

function message(row: { id: string; kind: 'push' | 'email' }) {
  return {
    body: { kind: row.kind === 'push' ? 'push.deliver' : 'email.send', outboxId: row.id },
    contentType: 'json' as const,
  };
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
  const outboxId = ctx.ids.id();
  await insertOutbox(ctx.env.DB, {
    id: outboxId,
    orgId: pass.orgId,
    kind: 'email',
    passId: pass.id,
    coalesceKey: null,
    payload: { to, attach: input.attach },
    now: ctx.clock.now(),
  });
  ctx.waitUntil(dispatchSafely(ctx, { passId: pass.id }));
  return { outboxId };
}
