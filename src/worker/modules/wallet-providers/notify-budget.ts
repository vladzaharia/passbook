import type { PushBudgetDto } from '../../../shared/contracts/passes.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { BUDGET_WINDOW_MS } from '../passes/change-messages.ts';
import type { Pass } from '../passes/repo.ts';
import { removalWallets } from './removal.ts';
import { providerNotifiedSince } from './repo-notify-budget.ts';

/**
 * Notifying messages a pass may get a day, per native wallet. Apple's own limit is the platform
 * setting `push.budgetPerDay`. Google allows 3 notifying messages per object per 24 h
 * (docs/design/wallet-providers/google-messages.md section 1). Samsung has no notifying call, so it has no budget.
 */
export const PROVIDER_NOTIFY_LIMIT = { google: 3 } as const;

/**
 * What a message would do in a wallet: a message that fits its budget is `deferred` to the Google send that
 * follows the update; over the limit it goes as text only. The message ledger and `wallet.messaged` record what
 * actually happened.
 */
export type BudgetOutcome = 'deferred' | 'over';

/** The live Google copy of the pass against its own daily limit; Apple's is not here. */
export async function providerBudgets(
  ctx: ServiceContext,
  pass: Pass,
): Promise<Partial<Record<'google', PushBudgetDto>>> {
  const out: Partial<Record<'google', PushBudgetDto>> = {};
  if (!(await removalWallets(ctx, pass, ['google'])).includes('google')) return out;
  const since = ctx.clock.now() - BUDGET_WINDOW_MS;
  const { used, oldest, quotaAt } = await providerNotifiedSince(
    ctx.env.DB,
    pass.id,
    'google',
    since,
  );
  // A quota refusal spends the object's budget until 24 h after it, whatever PassBook counted.
  out.google = {
    used: quotaAt === null ? used : Math.max(used, PROVIDER_NOTIFY_LIMIT.google),
    limit: PROVIDER_NOTIFY_LIMIT.google,
    resetsAt:
      quotaAt !== null
        ? quotaAt + BUDGET_WINDOW_MS
        : oldest === null
          ? null
          : oldest + BUDGET_WINDOW_MS,
  };
  return out;
}

/** The outcome per provider for one more notifying message: over its limit it must skip. */
export function budgetOutcomes(
  budgets: Partial<Record<'google', PushBudgetDto>>,
): Record<string, BudgetOutcome> {
  return Object.fromEntries(
    Object.entries(budgets).map(([provider, b]) => [
      provider,
      b.used < b.limit ? 'deferred' : 'over',
    ]),
  );
}
