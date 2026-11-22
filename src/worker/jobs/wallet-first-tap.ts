import type { WalletOperation } from '../modules/wallet-providers/instance-types.ts';
import { runWalletProviderOperation } from '../modules/wallet-providers/sync-operation.ts';
import type { WalletSyncRunResult } from '../modules/wallet-providers/sync-operation-context.ts';
import { createJobContext, type ServiceContext } from '../platform/service-context.ts';

/** The grant layer refuses every other purpose on this context: no purge, no closed-org work. */
const FIRST_TAP_PURPOSES = ['org_mode.job.wallet.sync', 'org_mode.job.wallet.record'] as const;

/**
 * A holder's first tap on Google builds the object itself, so the pass's pending upsert runs inside the
 * request. A request holds no job authority; the job context made here never leaves this function, and
 * it runs exactly one thing: the given Google upsert, which must belong to the pass's own org and mode.
 * Revokes, other providers and every other purpose (purge, closed orgs) are refused.
 * `tools/authority-scope.ts` allows only `wallet-providers/offers-google.ts` to import it.
 *
 * The run continues under `waitUntil` when the caller stops waiting, so a slow provider never strands
 * the claim.
 */
export function runFirstTapUpsert(
  ctx: ServiceContext,
  operation: WalletOperation,
  pass: { id: string; orgId: string; mode: 'live' | 'test' },
): Promise<WalletSyncRunResult> {
  if (
    operation.provider !== 'google' ||
    operation.kind !== 'upsert' ||
    operation.passId !== pass.id ||
    operation.orgId !== pass.orgId ||
    operation.mode !== pass.mode
  )
    return Promise.reject(new Error('The first tap runs only the pass’s own Google upsert.'));
  const job: ServiceContext = {
    ...createJobContext(ctx.env, 'wallet-first-tap', {
      clock: ctx.clock,
      log: ctx.log,
      allowedPurposes: FIRST_TAP_PURPOSES,
    }),
    ids: ctx.ids,
    requestId: ctx.requestId,
    waitUntil: ctx.waitUntil,
  };
  const run = runWalletProviderOperation(job, operation);
  ctx.waitUntil(run.catch(() => undefined));
  return run;
}
