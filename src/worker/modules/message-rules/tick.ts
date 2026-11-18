import type { ServiceContext } from '../../platform/service-context.ts';
import { dueRuleIds, leaseRules } from './repo.ts';

export const TICK_BATCH = 50;
/** A claimed rule whose job never ran is claimed again after this. */
export const LEASE_MS = 5 * 60_000;

/**
 * Minute hook. Only claims due rules and enqueues one check each: three queries at any scale. The
 * queue consumer's budget is the back-pressure; never add a per-rule loop here.
 */
export async function tickMessageRules(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const due = await dueRuleIds(ctx.env.DB, now, TICK_BATCH);
  if (due.length === 0) return;
  const ids = due.map((r) => r.id);
  await leaseRules(ctx.env.DB, ids, now, now + LEASE_MS);
  await ctx.env.JOBS.sendBatch(
    ids.map((ruleId) => ({ body: { kind: 'message_rule.check', ruleId, at: now } })),
  );
  ctx.log.info('message_rule.tick', { claimed: ids.length });
}
