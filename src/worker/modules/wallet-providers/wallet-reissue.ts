import { QUEUE_QUERY_BUDGET } from '../../jobs/query-budget.ts';
import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getWalletInstanceById } from './instance.ts';
import type { WalletMode, WalletProvider } from './instance-types.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import {
  claimReissueStep,
  countReissueInstances,
  listReissueInstanceIds,
  markReissueStepSent,
  purgeReissueSteps,
  type ReissueScope,
} from './repo-wallet-reissue.ts';

/**
 * Queries one copy's reconcile spends, measured in wallet-reissue.test.ts (which fails if it grows past this).
 * A run is a whole queue invocation (`estimateQueries`), so its batch is what fits the budget at that cost.
 */
export const QUERIES_PER_COPY = 40;
export const REISSUE_BATCH = Math.floor((QUEUE_QUERY_BUDGET - 60) / QUERIES_PER_COPY);
/**
 * One run's copies are about what the minute drain sends (30 operations a minute, voids first and every org in
 * turn, repo-instance.ts), so a reissue is paced to leave the queue free instead of filling it.
 */
export const PACE_SECONDS = 40;
/** A copy that fails is tried again from itself; after this many tries it is skipped, logged, and the rest go on. */
export const MAX_COPY_FAILURES = 3;
const STEP_KEEP_MS = 3 * 86_400_000;

/**
 * Wallet reissue, the Google and Samsung twin of the Apple bulk reissue: every active copy of the org's passes
 * in this wallet and mode (of one template, when named) is recompiled and sent again under a new operation,
 * so a changed release, art or compiler reaches cards whose passes did not change. Passes nobody has added
 * to a wallet have no copy yet and are left to the first tap (Q4). The chain runs to the last copy, paced.
 */
export async function startWalletReissue(
  ctx: ServiceContext,
  scope: ReissueScope,
): Promise<{ reissueId: string; instances: number }> {
  const instances = await countReissueInstances(ctx.env.DB, scope);
  const reissueId = ctx.ids.id();
  if (instances > 0)
    await ctx.env.JOBS.send({
      kind: 'wallet.reissue',
      reissueId,
      orgId: scope.orgId,
      mode: scope.mode as WalletMode,
      provider: scope.provider as WalletProvider,
      ...(scope.templateId === undefined ? {} : { templateId: scope.templateId }),
    });
  ctx.log.info('wallet.reissue_queued', {
    orgId: scope.orgId,
    provider: scope.provider,
    instances,
  });
  return { reissueId, instances };
}

/** `wallet.reissue`: one page of the scope, then the next after `after`. Idempotent under redelivery. */
export async function handleWalletReissue(
  job: JobOf<'wallet.reissue'>,
  ctx: ServiceContext,
): Promise<void> {
  const db = ctx.env.DB;
  const scope: ReissueScope = {
    orgId: job.orgId,
    mode: job.mode,
    provider: job.provider,
    templateId: job.templateId,
  };
  try {
    await requireCredentialRefKeyset(db, ctx.env);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.error('wallet.reissue_keyset_unavailable', { code: error.code });
    return;
  }
  const ids = await listReissueInstanceIds(db, scope, job.after ?? '', REISSUE_BATCH);
  let done = job.after ?? '';
  for (const instanceId of ids) {
    try {
      const instance = await getWalletInstanceById(db, { ...scope, instanceId });
      // The operation's key carries the reissue id: a redelivered job finds its operations and adds none.
      if (instance) await reconcileWalletInstance(ctx, instance, undefined, false, job.reissueId);
    } catch {
      const failures = job.failedId === instanceId ? (job.failures ?? 0) + 1 : 1;
      if (failures < MAX_COPY_FAILURES) {
        ctx.log.warn('wallet.reissue_instance_failed', {
          code: 'WALLET_REISSUE_INSTANCE',
          failures,
        });
        // Resume from the failed copy, not after it.
        await continueReissue(ctx, job, { after: done, failedId: instanceId, failures });
        return;
      }
      ctx.log.error('wallet.reissue_instance_skipped', {
        code: 'WALLET_REISSUE_SKIPPED',
        failures,
      });
    }
    done = instanceId;
  }
  if (ids.length < REISSUE_BATCH) {
    await purgeReissueSteps(db, ctx.clock.now() - STEP_KEEP_MS);
    return;
  }
  await continueReissue(ctx, job, { after: done });
}

async function continueReissue(
  ctx: ServiceContext,
  job: JobOf<'wallet.reissue'>,
  next: { after: string; failedId?: string; failures?: number },
): Promise<void> {
  const step = `${next.after}|${next.failures ?? 0}`;
  const now = ctx.clock.now();
  if (!(await claimReissueStep(ctx.env.DB, { reissueId: job.reissueId, step, now }))) return;
  const { failedId: _f, failures: _n, ...rest } = job;
  await ctx.env.JOBS.send({ ...rest, ...next }, { delaySeconds: PACE_SECONDS });
  await markReissueStepSent(ctx.env.DB, { reissueId: job.reissueId, step, now });
}
