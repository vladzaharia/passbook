import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import {
  ackDirtyWalletInstance,
  deferDirtyWalletInstance,
  deferWalletRetirement,
  expireWalletClaims,
  getWalletInstanceById,
  listDirtyWalletInstances,
  listDueWalletOperations,
  listWalletRetirementsReady,
  purgeExpiredWalletOffers,
} from './instance.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { nextInstanceBoundary } from './lifecycle-boundary.ts';
import { backfillSystemProjections } from './projection-system-backfill.ts';
import { walletProviderReleaseReason, walletProviderRevokes } from './provider-policy.ts';
import { purgeExpiredGoogleCallbackReplays } from './repo-google-callback-replay.ts';
import { purgeGoogleMessages } from './repo-google-messages.ts';
import { deferDirtyInstance } from './repo-instance.ts';
import { ackCleanWalletPlaceholder, deferWalletSyncOperation } from './repo-sync-queue.ts';
import { listUncertainOperations } from './repo-sync-uncertain.ts';
import { walletSyncHasWork } from './repo-sync-work.ts';
import { refreshExpiringSamsungCards } from './samsung-verification.ts';
import { runWalletProviderOperation } from './sync-operation.ts';
import { finishWalletProviderRetirement } from './sync-operation-retirement.ts';
import { sweepUncertainOperations } from './sync-uncertain.ts';

const BATCH_SIZE = 30;
const BLOCKED_DELAY_MS = 60_000;

/**
 * Runnable from the minute cron or an authorized manual job. All work is bounded per invocation.
 * Expired in-flight requests become uncertain, never silently retried; operators must establish
 * transport settlement before using settleWalletClaim. Provider outcomes contain no loggable body.
 */
export async function drainWalletProviderSync(ctx: ServiceContext): Promise<void> {
  // Local bookkeeping (placeholders, retirement records) still runs; provider calls do not. Draining has calls
  // (revokes), so it is not skipped.
  if (!walletProviderRevokes('google') && !walletProviderRevokes('samsung'))
    ctx.log.info('wallet.sync_provider_calls_skipped', {
      code: 'WALLET_PROVIDER_DISABLED',
      reason: walletProviderReleaseReason('google'),
    });
  ctx = snapshotWalletCredentialContext(ctx);
  const db = ctx.env.DB;
  await purgeExpiredWalletOffers(db, ctx.clock.now(), BATCH_SIZE);
  await purgeExpiredGoogleCallbackReplays(db, ctx.clock.now());
  await refreshExpiringSamsungCards(ctx, 10);
  await purgeGoogleMessages(db, ctx.clock.now(), 100);
  await backfillSystemProjections(ctx);
  // Nothing queued means nothing to pin: a fresh deployment has no keyset until its first pass.
  if (
    !(await walletSyncHasWork(db, ctx.clock.now())) &&
    (await listUncertainOperations(db, ctx.clock.now(), 1)).length === 0
  )
    return;
  try {
    await requireCredentialRefKeyset(db, ctx.env);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.error('wallet.sync_keyset_unavailable', { code: error.code });
    return;
  }
  await expireWalletClaims(ctx, ctx.clock.now(), BATCH_SIZE);
  await sweepUncertainOperations(ctx, BATCH_SIZE);
  const dirty = await listDirtyWalletInstances(db, ctx.clock.now(), BATCH_SIZE);
  for (const item of dirty) {
    try {
      const instance = await getWalletInstanceById(db, item);
      if (!instance) {
        await ackDirtyWalletInstance(db, item);
        continue;
      }
      const result = await reconcileWalletInstance(ctx, instance, undefined, false);
      if (result === 'scheduled' || result === 'unchanged') {
        // A pass that expires or rolls to its next event is recompiled then, with no edit to trigger it.
        const next = await nextInstanceBoundary(ctx, instance.passId);
        if (next === null) await ackDirtyWalletInstance(db, item);
        else await deferDirtyInstance(db, { ...item, nextAttemptAt: next });
      } else if (instance.lifecycle === 'revoked' && instance.retirementCause === 'channel_off')
        // A settled channel-off copy has nothing left to schedule; a successor is a different row.
        await ackDirtyWalletInstance(db, item);
      else if (
        !(
          (instance.lifecycle === 'blocked' || instance.lifecycle === 'ready') &&
          (await ackCleanWalletPlaceholder(db, item))
        )
      ) {
        await deferDirtyWalletInstance(db, {
          ...item,
          now: ctx.clock.now(),
          delayMs: BLOCKED_DELAY_MS,
        });
      }
    } catch {
      await deferDirtyWalletInstance(db, {
        ...item,
        now: ctx.clock.now(),
        delayMs: BLOCKED_DELAY_MS,
      });
      ctx.log.warn('wallet.sync_dirty_failed', { code: 'WALLET_SYNC_DIRTY' });
    }
  }
  const due = await listDueWalletOperations(db, ctx.clock.now(), BATCH_SIZE);
  for (const operation of due) {
    try {
      const result = await runWalletProviderOperation(ctx, operation);
      if (result === 'deferred')
        await deferWalletSyncOperation(ctx, operation, ctx.clock.now(), BLOCKED_DELAY_MS);
    } catch {
      // A claim which may have reached a provider stays held; expiry moves it to uncertain.
      ctx.log.warn('wallet.sync_operation_failed', { code: 'WALLET_SYNC_OPERATION' });
    }
  }
  const retirements = await listWalletRetirementsReady(db, ctx.clock.now(), BATCH_SIZE);
  for (const retirement of retirements) {
    try {
      if (!(await finishWalletProviderRetirement(ctx, retirement)))
        await deferWalletRetirement(db, {
          ...retirement,
          now: ctx.clock.now(),
          delayMs: BLOCKED_DELAY_MS,
        });
    } catch {
      await deferWalletRetirement(db, {
        ...retirement,
        now: ctx.clock.now(),
        delayMs: BLOCKED_DELAY_MS,
      });
      ctx.log.warn('wallet.sync_retirement_failed', { code: 'WALLET_SYNC_RETIREMENT' });
    }
  }
}
