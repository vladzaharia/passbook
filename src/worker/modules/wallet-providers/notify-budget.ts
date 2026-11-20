import type { PushBudgetDto } from '../../../shared/contracts/passes.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { BUDGET_WINDOW_MS } from '../passes/change-messages.ts';
import type { Pass } from '../passes/repo.ts';
import { removalWallets } from './removal.ts';
import { providerNotifiedSince } from './repo-notify-budget.ts';

/**
 * Notifying messages a pass may get a day, per native wallet. Apple's own limit is the platform
 * setting `push.budgetPerDay`. Google's rate limit is unconfirmed (docs/design/wallet-providers/
 * google-wallet.md); Samsung has no user-facing message call, so its updates never notify.
 * Revisit both after the real-device runbook.
 */
export const PROVIDER_NOTIFY_LIMIT = { google: 3, samsung: 0 } as const;

export type BudgetOutcome = 'within' | 'over';

/** Each live Google or Samsung copy of the pass against its own daily limit; Apple's is not here. */
export async function providerBudgets(
  ctx: ServiceContext,
  pass: Pass,
): Promise<Partial<Record<'google' | 'samsung', PushBudgetDto>>> {
  const out: Partial<Record<'google' | 'samsung', PushBudgetDto>> = {};
  const since = ctx.clock.now() - BUDGET_WINDOW_MS;
  for (const wallet of await removalWallets(ctx.env.DB, pass)) {
    if (wallet === 'apple') continue;
    const { used, oldest } = await providerNotifiedSince(ctx.env.DB, pass.id, wallet, since);
    out[wallet] = {
      used,
      limit: PROVIDER_NOTIFY_LIMIT[wallet],
      resetsAt: oldest === null ? null : oldest + BUDGET_WINDOW_MS,
    };
  }
  return out;
}

/** The outcome per provider for one more notifying message. */
export function budgetOutcomes(
  budgets: Partial<Record<'google' | 'samsung', PushBudgetDto>>,
): Record<string, BudgetOutcome> {
  return Object.fromEntries(
    Object.entries(budgets).map(([provider, b]) => [
      provider,
      b.used < b.limit ? 'within' : 'over',
    ]),
  );
}
