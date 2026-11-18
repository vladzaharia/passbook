import type { ServiceContext } from '../../platform/service-context.ts';
import { chainsWithOld, trimChain } from './repo-receipts.ts';

/** Receipts are kept 6 years, then removed oldest-first behind an anchor. */
export const RECEIPT_KEEP_MS = 6 * 365 * 86_400_000;
const TRIM_CHAINS_PER_RUN = 50;
const TRIM_ROWS_PER_CHAIN = 200;

/** Daily hook `retention.receipts`: drops receipts past 6 years, never a chain's newest. */
export async function dailyReceipts(ctx: ServiceContext): Promise<void> {
  const cutoff = ctx.clock.now() - RECEIPT_KEEP_MS;
  let removed = 0;
  for (const chain of await chainsWithOld(ctx.env.DB, cutoff, TRIM_CHAINS_PER_RUN))
    removed += await trimChain(ctx.env.DB, chain, cutoff, TRIM_ROWS_PER_CHAIN);
  if (removed > 0) ctx.log.info('retention.receipts_trimmed', { removed });
}
