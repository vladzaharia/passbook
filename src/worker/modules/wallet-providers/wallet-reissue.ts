import { QUEUE_QUERY_BUDGET } from '../../jobs/query-budget.ts';
import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import { startOrgOperation } from '../operations/start-org.ts';
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
  /** Reports the run as an operation: a new one for this actor, or the one a retry restarts. */
  operation?: {
    actor: { type: 'user' | 'api_key' | 'system'; id: string | null };
    existing?: { id: string; attempt: number };
  },
): Promise<{ reissueId: string; instances: number; operationId: string | null }> {
  const instances = await countReissueInstances(ctx.env.DB, scope);
  const op =
    operation && instances > 0
      ? (operation.existing ??
        (await startOrgOperation(ctx, operation.actor, {
          kind: 'wallet.reissue',
          orgId: scope.orgId,
          mode: scope.mode as WalletMode,
          target: {
            type: 'wallet-provider',
            id: scope.templateId ? `${scope.provider}:${scope.templateId}` : scope.provider,
          },
        })))
      : null;
  // The first attempt's chain is named for the operation; a retry gets a chain (and update keys) of its own.
  const reissueId = op ? (op.attempt > 1 ? `${op.id}-r${op.attempt}` : op.id) : ctx.ids.id();
  if (op) {
    const copies = progressOf(ctx, op.id, op.attempt).step('copies');
    copies.total(instances);
    await copies.count(0);
  }
  if (instances > 0)
    await ctx.env.JOBS.send({
      kind: 'wallet.reissue',
      reissueId,
      orgId: scope.orgId,
      mode: scope.mode as WalletMode,
      provider: scope.provider as WalletProvider,
      ...(scope.templateId === undefined ? {} : { templateId: scope.templateId }),
      ...(op ? { operationId: op.id, attempt: op.attempt, total: instances, done: 0 } : {}),
    });
  ctx.log.info('wallet.reissue_queued', {
    orgId: scope.orgId,
    provider: scope.provider,
    instances,
  });
  return { reissueId, instances, operationId: op?.id ?? null };
}

/** `wallet.reissue`: one page of the scope, then the next after `after`. Idempotent under redelivery. */
export async function handleWalletReissue(
  job: JobOf<'wallet.reissue'>,
  ctx: ServiceContext,
): Promise<void> {
  const db = ctx.env.DB;
  const progress = progressOf(ctx, job.operationId, job.attempt ?? 1);
  const copies = progress.step('copies');
  if (job.total !== undefined) copies.total(job.total);
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
    await progress.fail(new AppError('WALLET_REISSUE_KEYSET', 503, 'Credentials are unavailable.'));
    return;
  }
  const ids = await listReissueInstanceIds(db, scope, job.after ?? '', REISSUE_BATCH);
  let done = job.after ?? '';
  let skipped = job.skipped ?? 0;
  let sent = job.done ?? 0;
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
        await continueReissue(ctx, job, {
          after: done,
          failedId: instanceId,
          failures,
          done: sent,
          skipped,
        });
        return;
      }
      ctx.log.error('wallet.reissue_instance_skipped', {
        code: 'WALLET_REISSUE_SKIPPED',
        failures,
      });
      skipped++;
    }
    done = instanceId;
    sent++;
  }
  await copies.count(sent);
  if (ids.length < REISSUE_BATCH) {
    await purgeReissueSteps(db, ctx.clock.now() - STEP_KEEP_MS);
    await copies.done();
    await progress.succeed({
      href: null,
      ids: { updated: String(sent - skipped), skipped: String(skipped) },
    });
    return;
  }
  await continueReissue(ctx, job, { after: done, done: sent, skipped });
}

async function continueReissue(
  ctx: ServiceContext,
  job: JobOf<'wallet.reissue'>,
  next: { after: string; failedId?: string; failures?: number; done?: number; skipped?: number },
): Promise<void> {
  const step = `${next.after}|${next.failures ?? 0}`;
  const now = ctx.clock.now();
  if (!(await claimReissueStep(ctx.env.DB, { reissueId: job.reissueId, step, now }))) return;
  const { failedId: _f, failures: _n, ...rest } = job;
  await ctx.env.JOBS.send({ ...rest, ...next }, { delaySeconds: PACE_SECONDS });
  await markReissueStepSent(ctx.env.DB, { reissueId: job.reissueId, step, now });
}
