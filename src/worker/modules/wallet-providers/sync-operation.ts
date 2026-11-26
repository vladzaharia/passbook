import { toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import {
  getSamsungRefreshTarget,
  inspectSamsungRefRetirement,
  retireExpiredUnpromotedRef,
} from './callbacks-ref.ts';
import {
  claimWalletOperation,
  getWalletOperation,
  markWalletClaimUncertain,
  newWalletClaimHandle,
  recordWalletOperationOutcome,
  walletOperationFresh,
} from './instance.ts';
import type { WalletClaimRef, WalletOperation } from './instance-types.ts';
import { walletProviderDisabledReason, walletProviderRevokes } from './provider-policy.ts';
import type { OutcomeReceipt } from './repo-instance-outcomes.ts';
import {
  originalScope,
  type WalletSyncOperationExecution,
  type WalletSyncRunResult,
} from './sync-operation-context.ts';
import { runGoogleWalletProviderOperation } from './sync-operation-google.ts';
import { completeWalletSyncOperation as complete } from './sync-operation-retirement.ts';
import { runSamsungWalletProviderOperation } from './sync-operation-samsung.ts';

/**
 * Claim one exact operation. Revocation and restore wait behind a prior claimed or uncertain write,
 * so a late update cannot overtake them. A missing Samsung routing hint is not an installation
 * result and leaves the operation pending without consuming an attempt.
 */
export async function runWalletProviderOperation(
  ctx: ServiceContext,
  candidate: WalletOperation,
): Promise<WalletSyncRunResult> {
  ctx = snapshotWalletCredentialContext(ctx);
  candidate = { ...candidate };
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  let unissuedCandidate = false;
  let unconfirmed = false;
  if (candidate.provider === 'samsung') {
    const scope = {
      instanceId: candidate.instanceId,
      orgId: candidate.orgId,
      mode: candidate.mode,
      operationVersion: candidate.version,
    };
    const target = await getSamsungRefreshTarget(ctx, scope);
    if (!target || target.countryCodes.length === 0) {
      if (candidate.kind !== 'revoke') return 'deferred';
      // A served ref that was never confirmed and has no known market is closed, not waited for
      // forever: erasure must not depend on evidence that may never arrive.
      const disposition = await inspectSamsungRefRetirement(ctx, scope);
      if (disposition !== 'no_external_card' && disposition !== 'served_unconfirmed')
        return 'deferred';
      unissuedCandidate = true;
      unconfirmed = disposition === 'served_unconfirmed';
    }
  }
  // A disabled provider is never called and the operation is not claimed, so it cannot go uncertain.
  // Only a locally proven absence (no external card) can still settle.
  // An org that is not enrolled (Off, held, revoked) is not called either; a revoke needs only the release to be
  // released or draining, so copies already in wallets go void after a rollback.
  if (!unissuedCandidate) {
    const reason =
      candidate.kind === 'revoke'
        ? walletProviderRevokes(candidate.provider, candidate.mode)
          ? null
          : 'not_released'
        : await walletProviderDisabledReason(
            ctx.env.DB,
            candidate.provider,
            candidate.orgId,
            candidate.mode,
          );
    if (reason) return 'deferred';
  }
  const claim: WalletClaimRef = {
    orgId: candidate.orgId,
    mode: candidate.mode,
    provider: candidate.provider,
    instanceId: candidate.instanceId,
    version: candidate.version,
    claimHandle: newWalletClaimHandle(),
    now: ctx.clock.now(),
  };
  if ((await claimWalletOperation(ctx, claim)) !== 'claimed') return 'not_claimed';
  const op = await getWalletOperation(ctx.env.DB, claim);
  if (!op) return 'uncertain';
  let responseSequence = 0;
  const execution: WalletSyncOperationExecution = {
    ctx,
    claim,
    op,
    fenceLost: false,
    lastResponseStatus: null,
    holdClaim: async () => {
      await markWalletClaimUncertain(ctx, { ...claim, now: ctx.clock.now() });
      return 'uncertain';
    },
    assertCurrent: async () => {
      try {
        if (await walletOperationFresh(ctx.env.DB, { ...claim, now: ctx.clock.now() })) return;
      } catch {
        execution.fenceLost = true;
        ctx.log.warn('wallet.sync_keyset_unavailable', { code: 'WALLET_SYNC_KEYSET' });
        throw new Error('Wallet credential keyset unavailable.');
      }
      execution.fenceLost = true;
      throw new Error('Wallet operation changed.');
    },
    onProviderResponse: async (response) => {
      const sequence = ++responseSequence;
      const payload = new TextEncoder().encode(
        JSON.stringify({
          stage: response.stage,
          method: response.method,
          status: response.status,
          body: toBase64Url(response.body),
        }),
      );
      let receipt: OutcomeReceipt;
      try {
        receipt = await recordWalletOperationOutcome(ctx, {
          ...claim,
          now: ctx.clock.now(),
          sequence,
          eventKey: `${sequence}:${response.stage}:${response.method}`,
          body: payload,
          reason: response.status < 400 ? 'ok' : 'provider_error',
          httpStatus: response.status,
          method: response.method,
          stage: response.stage,
        });
      } catch (error) {
        execution.fenceLost = true;
        throw error;
      }
      if (receipt !== 'recorded' && receipt !== 'replay') {
        execution.fenceLost = true;
        throw new Error('Wallet outcome unavailable.');
      }
      execution.lastResponseStatus = response.status;
    },
  };
  const { holdClaim, assertCurrent } = execution;

  const binding = await originalScope(ctx, op);
  if (!binding) return holdClaim();
  try {
    await assertCurrent();
  } catch {
    ctx.log.warn('wallet.sync_fence_lost', { code: 'WALLET_SYNC_FENCE' });
    return holdClaim();
  }
  if (unissuedCandidate) {
    const disposition = await retireExpiredUnpromotedRef(ctx, {
      instanceId: op.instanceId,
      orgId: op.orgId,
      mode: op.mode,
      operationVersion: op.version,
      claimHandle: claim.claimHandle,
    });
    if (disposition !== 'no_external_card') {
      return (await complete(ctx, claim, op, {
        kind: 'failure',
        reason: 'unavailable',
        retryable: true,
      })) === 'completed'
        ? 'deferred'
        : 'uncertain';
    }
    if (unconfirmed)
      ctx.log.warn('wallet.samsung_served_unconfirmed', {
        code: 'WALLET_SAMSUNG_SERVED_UNCONFIRMED',
        orgId: op.orgId,
        mode: op.mode,
      });
    // This is a locally proven absence, not a fabricated provider HTTP response.
    return complete(ctx, claim, op, { kind: 'not_issued' });
  }
  const retirement = {
    instanceId: op.instanceId,
    operationId: op.id,
    version: op.version,
    claimHandle: claim.claimHandle,
  };

  if (op.provider === 'google')
    return runGoogleWalletProviderOperation(execution, binding, retirement);
  return runSamsungWalletProviderOperation(execution, binding, retirement);
}
