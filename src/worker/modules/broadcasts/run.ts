import type { BroadcastState } from '../../../shared/contracts/broadcasts.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { finishRun } from '../../platform/workflow-runs.ts';
import { actorOf, targetFilter } from './apply.ts';
import { countsOf } from './dto.ts';
import {
  type BroadcastRow,
  casState,
  countItems,
  getBroadcast,
  insertBroadcastStmt,
  setTargeted,
} from './repo.ts';
import { countTargeted } from './repo-target.ts';

/** First workflow step: counts the target. False when the broadcast cannot be sent (cancelled, already settled). */
export async function startedBroadcast(
  ctx: ServiceContext,
  instanceId: string,
  broadcastId: string,
): Promise<boolean> {
  let row = await getBroadcast(ctx.env.DB, broadcastId, null);
  // A launch that looked failed (the create call errored) may revert to scheduled while this
  // instance runs: take over instead of skipping.
  if (row?.state === 'scheduled') {
    await casState(ctx.env.DB, broadcastId, ['scheduled'], 'sending', {
      startedAt: ctx.clock.now(),
    });
    row = await getBroadcast(ctx.env.DB, broadcastId, null);
  }
  if (row?.state !== 'sending') {
    await finishRun(ctx.env.DB, instanceId, 'complete', ctx.clock.now());
    return false;
  }
  await setTargeted(
    ctx.env.DB,
    broadcastId,
    await countTargeted(ctx.env.DB, targetFilter(row, null, 1), ctx.clock.now()),
  );
  await finishRun(ctx.env.DB, instanceId, 'running', ctx.clock.now());
  return true;
}

function endState(counts: ReturnType<typeof countsOf>): BroadcastState {
  if (counts.failed === 0) return 'sent';
  return counts.updated + counts.unchanged > 0 ? 'partial' : 'failed';
}

/** The follow-up that clears a message `clearAfter` ms after the send started. */
async function scheduleClear(ctx: ServiceContext, row: BroadcastRow): Promise<void> {
  if (row.kind !== 'message' || !row.clear_after) return;
  const patch = JSON.parse(row.patch) as { message?: string };
  const at = Math.max((row.started_at ?? ctx.clock.now()) + row.clear_after, ctx.clock.now());
  await insertBroadcastStmt(ctx.env.DB, {
    id: ctx.ids.id(),
    orgId: row.org_id,
    mode: row.mode,
    kind: 'message',
    name: `Clear: ${row.name}`.slice(0, 80),
    state: 'scheduled',
    target: JSON.parse(row.target),
    patch: { message: '' },
    notify: false,
    at,
    clearAfter: null,
    expect: { message: patch.message ?? '' },
    parentId: row.id,
    actor: actorOf(row),
    now: ctx.clock.now(),
  }).run();
}

/** Last step: settles the state from the per-pass outcomes. `errorCode` marks a failed run. */
export async function finishBroadcast(
  ctx: ServiceContext,
  instanceId: string,
  broadcastId: string,
  errorCode: string | null = null,
): Promise<BroadcastState> {
  const row = await getBroadcast(ctx.env.DB, broadcastId, null);
  if (!row) return 'failed';
  const counts = countsOf(row, await countItems(ctx.env.DB, [broadcastId]));
  const state = errorCode ? 'failed' : endState(counts);
  const now = ctx.clock.now();
  const won = await casState(ctx.env.DB, broadcastId, ['sending'], state, {
    finishedAt: now,
    errorCode,
  });
  if (won) ctx.log.info('broadcast.done', { broadcastId, state, ...counts });
  // A retry after a failed follow-up insert loses the CAS but still owes the follow-up; the
  // unique parent index makes the insert idempotent.
  const settled = won ? state : row.state;
  if (settled === 'sent' || settled === 'partial') await scheduleClear(ctx, row);
  await finishRun(ctx.env.DB, instanceId, errorCode ? 'errored' : 'complete', now, {
    errorCode: errorCode ?? (state === 'sent' ? null : 'PARTIAL_FAILURE'),
  });
  return state;
}
