import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getWalletInstanceById } from './instance.ts';
import type { WalletMode, WalletProvider } from './instance-types.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import {
  countReissueInstances,
  listReissueInstanceIds,
  type ReissueScope,
} from './repo-wallet-reissue.ts';

/** Instances per run, and runs per request; a larger set is finished by the next reissue. */
export const REISSUE_BATCH = 50;
export const REISSUE_MAX_RUNS = 400;
const CONTINUE_DELAY_SECONDS = 5;

/**
 * Wallet reissue, the Google and Samsung twin of the Apple bulk reissue: every active copy of the org's passes
 * in this wallet and mode (of one template, when named) is recompiled and sent again under a new operation,
 * so a changed release, art or compiler reaches cards whose passes did not change. Passes nobody has added
 * to a wallet have no copy yet and are left to the first tap (Q4).
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
  for (const instanceId of ids) {
    try {
      const instance = await getWalletInstanceById(db, { ...scope, instanceId });
      // The operation's key carries the reissue id: a redelivered job finds its operations and adds none.
      if (instance) await reconcileWalletInstance(ctx, instance, undefined, false, job.reissueId);
    } catch {
      ctx.log.warn('wallet.reissue_instance_failed', { code: 'WALLET_REISSUE_INSTANCE' });
    }
  }
  const last = ids.at(-1);
  if (ids.length < REISSUE_BATCH || !last) return;
  const runs = (job.runs ?? 0) + 1;
  if (runs >= REISSUE_MAX_RUNS) {
    ctx.log.warn('wallet.reissue_capped', { code: 'WALLET_REISSUE_CAP', orgId: job.orgId });
    return;
  }
  await ctx.env.JOBS.send({ ...job, after: last, runs }, { delaySeconds: CONTINUE_DELAY_SECONDS });
}
