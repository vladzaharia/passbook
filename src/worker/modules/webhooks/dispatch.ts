import type { ServiceContext } from '../../platform/service-context.ts';
import { type LaneKey, listDueLanes } from './repo-delivery-read.ts';
import { claimLane, releaseLane } from './repo-delivery-state.ts';

/** A running handler holds its lane this long, extended before every POST: a crash frees it within it. */
export const LANE_HOLD_MS = 60_000;
/**
 * A queued message holds its lane this long before a handler starts: the sweep leaves it alone while the
 * queue is backed up, and a lost message frees the lane after it.
 */
export const ENQUEUED_HOLD_MS = 5 * 60_000;

/**
 * Claims the lane and enqueues its handler. False when the lane is busy, has nothing due, or the
 * queue refused (the claim is then released, and the next kick or the sweep tries again).
 */
export async function dispatchLane(ctx: ServiceContext, lane: LaneKey): Promise<boolean> {
  const token = ctx.ids.token(16);
  if (!(await claimLane(ctx.env.DB, lane, token, ctx.clock.now(), ENQUEUED_HOLD_MS))) return false;
  try {
    await ctx.env.WEBHOOK_JOBS.send({
      kind: 'webhook.deliver',
      endpointId: lane.endpointId,
      orgId: lane.orgId,
      mode: lane.mode,
      lane: token,
    });
    return true;
  } catch (error) {
    ctx.log.warn('webhooks.enqueue_failed', {
      orgId: lane.orgId,
      endpointId: lane.endpointId,
      code: 'WEBHOOK_ENQUEUE',
      error,
    });
    await releaseLane(ctx.env.DB, lane, token);
    return false;
  }
}

/** Claims up to `limit` lanes that have due deliveries. Returns how many handlers were enqueued. */
export async function dispatchDue(ctx: ServiceContext, limit: number): Promise<number> {
  let enqueued = 0;
  for (const lane of await listDueLanes(ctx.env.DB, ctx.clock.now(), limit)) {
    if (await dispatchLane(ctx, lane)) enqueued++;
  }
  return enqueued;
}
