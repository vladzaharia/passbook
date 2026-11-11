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
import { walletProviderDisabledReason, walletProviderEnabled } from './provider-policy.ts';
import { ackCleanWalletPlaceholder, deferWalletSyncOperation } from './repo-sync-queue.ts';
import { runWalletProviderOperation } from './sync-operation.ts';
import { finishWalletProviderRetirement } from './sync-operation-retirement.ts';

const BATCH_SIZE = 30;
const BLOCKED_DELAY_MS = 60_000;

/**
 * Runnable from the minute cron or an authorized manual job. All work is bounded per invocation.
 * Expired in-flight requests become uncertain, never silently retried; operators must establish
 * transport settlement before using settleWalletClaim. Provider outcomes contain no loggable body.
 */
export async function drainWalletProviderSync(ctx: ServiceContext): Promise<void> {
  // Local bookkeeping (placeholders, retirement records) still runs; provider calls do not.
  if (!walletProviderEnabled('google') && !walletProviderEnabled('samsung'))
    ctx.log.info('wallet.sync_provider_calls_skipped', {
      code: 'WALLET_PROVIDER_DISABLED',
      reason: walletProviderDisabledReason('google'),
    });
  ctx = snapshotWalletCredentialContext(ctx);
  const db = ctx.env.DB;
  const credentialKeysetCommitment = await requireCredentialRefKeyset(db, ctx.env);
  await purgeExpiredWalletOffers(db, ctx.clock.now(), BATCH_SIZE);
  await expireWalletClaims(db, ctx.clock.now(), BATCH_SIZE, credentialKeysetCommitment);
  const dirty = await listDirtyWalletInstances(
    db,
    ctx.clock.now(),
    BATCH_SIZE,
    credentialKeysetCommitment,
  );
  for (const item of dirty) {
    try {
      const instance = await getWalletInstanceById(db, item);
      if (!instance) {
        await ackDirtyWalletInstance(db, item);
        continue;
      }
      const result = await reconcileWalletInstance(
        ctx,
        instance,
        undefined,
        false,
        item.credentialKeysetCommitment,
      );
      if (result === 'scheduled' || result === 'unchanged') await ackDirtyWalletInstance(db, item);
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
  const due = await listDueWalletOperations(
    db,
    ctx.clock.now(),
    BATCH_SIZE,
    credentialKeysetCommitment,
  );
  for (const operation of due) {
    try {
      const result = await runWalletProviderOperation(ctx, operation);
      if (result === 'deferred')
        await deferWalletSyncOperation(db, operation, ctx.clock.now(), BLOCKED_DELAY_MS);
    } catch {
      // A claim which may have reached a provider stays held; expiry moves it to uncertain.
      ctx.log.warn('wallet.sync_operation_failed', { code: 'WALLET_SYNC_OPERATION' });
    }
  }
  const retirements = await listWalletRetirementsReady(
    db,
    ctx.clock.now(),
    BATCH_SIZE,
    credentialKeysetCommitment,
  );
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
