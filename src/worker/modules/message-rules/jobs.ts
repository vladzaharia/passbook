import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { checkRule } from './check.ts';
import { deleteTestRules } from './repo.ts';
import { deleteOldFires } from './repo-window.ts';

const DAY = 86_400_000;
const FIRE_RETENTION_DAYS = 400;
const TEST_RULE_DAYS = 30;
const PURGE_LIMIT = 5000;
const PURGE_BUDGET_MS = 10_000;
const MAX_ROUNDS = 40;

export const handleMessageRuleCheck = (
  job: JobOf<'message_rule.check'>,
  ctx: ServiceContext,
): Promise<void> => checkRule(ctx, job);

/** Daily: fires older than 400 days (yearly occurrences are keyed by year) and stale test rules. */
export async function dailyMessageRules(ctx: ServiceContext, batch = PURGE_LIMIT): Promise<void> {
  const now = ctx.clock.now();
  // Batches until one comes back short or the time budget is spent: a big backlog drains over days.
  let fires = 0;
  for (let round = 0; round < MAX_ROUNDS && ctx.clock.now() - now < PURGE_BUDGET_MS; round++) {
    const n = await deleteOldFires(ctx.env.DB, now - FIRE_RETENTION_DAYS * DAY, batch);
    fires += n;
    if (n < batch) break;
  }
  const testRules = await deleteTestRules(ctx.env.DB, now - TEST_RULE_DAYS * DAY, 100);
  ctx.log.info('message_rules.retention', { fires, testRules });
}
