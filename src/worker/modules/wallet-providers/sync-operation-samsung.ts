import { getSamsungRefreshTarget } from './callbacks-ref.ts';
import { markWalletClaimUncertain } from './instance.ts';
import {
  beginSamsungSyncTarget,
  ensureSamsungSyncTargets,
  finishSamsungSyncTarget,
  listSamsungSyncTargets,
} from './repo-sync-targets.ts';
import { sendSamsungRuntimeUpdate, type WalletRetirementClaim } from './runtime.ts';
import { SamsungNotificationError } from './samsung.ts';
import { classifyWalletSyncFailure } from './sync-errors.ts';
import type {
  WalletSyncOperationBinding,
  WalletSyncOperationExecution,
  WalletSyncRunResult,
} from './sync-operation-context.ts';
import { completeWalletSyncOperation as complete } from './sync-operation-retirement.ts';

export async function runSamsungWalletProviderOperation(
  execution: WalletSyncOperationExecution,
  binding: WalletSyncOperationBinding,
  retirement: WalletRetirementClaim,
): Promise<WalletSyncRunResult> {
  const { ctx, claim, op, assertCurrent, onProviderResponse, holdClaim } = execution;
  const target = await getSamsungRefreshTarget(ctx, {
    instanceId: op.instanceId,
    orgId: op.orgId,
    mode: op.mode,
    operationVersion: op.version,
    credentialKeysetCommitment: claim.credentialKeysetCommitment,
  });
  try {
    await assertCurrent();
  } catch {
    ctx.log.warn('wallet.sync_fence_lost', { code: 'WALLET_SYNC_FENCE' });
    return 'uncertain';
  }
  if (
    !target ||
    target.countryCodes.length === 0 ||
    binding.original.projection.provider !== 'samsung'
  ) {
    return (await complete(ctx, claim, op, {
      kind: 'failure',
      reason: 'unavailable',
      retryable: true,
    })) === 'completed'
      ? 'deferred'
      : 'uncertain';
  }
  await ensureSamsungSyncTargets(ctx, { ...claim, now: ctx.clock.now() });
  const targets = await listSamsungSyncTargets(ctx, claim);
  for (const item of targets) {
    if (item.state !== 'pending' && item.state !== 'retry') continue;
    try {
      await assertCurrent();
    } catch {
      ctx.log.warn('wallet.sync_fence_lost', { code: 'WALLET_SYNC_FENCE' });
      return holdClaim();
    }
    const attempt = await beginSamsungSyncTarget(ctx, claim, item.countryCode);
    if (attempt === null) continue;
    execution.lastResponseStatus = null;
    try {
      await sendSamsungRuntimeUpdate(ctx, binding.scope, {
        cc2: item.countryCode,
        type: binding.original.projection.cardType,
        refId: target.refId,
        state: op.kind === 'revoke' ? 'DELETED' : 'UPDATED',
        attempt,
        assertCurrent,
        onProviderResponse,
        ...(op.kind === 'revoke' ? { retirement } : {}),
      });
      if (
        !(await finishSamsungSyncTarget(ctx, claim, item.countryCode, {
          kind: 'success',
          ...(execution.lastResponseStatus === null
            ? {}
            : { status: execution.lastResponseStatus }),
        }))
      ) {
        await markWalletClaimUncertain(ctx.env.DB, { ...claim, now: ctx.clock.now() });
        return 'uncertain';
      }
    } catch (error) {
      if (execution.fenceLost) return holdClaim();
      const failure = classifyWalletSyncFailure('samsung', attempt, error);
      const status = failure.status === null ? {} : { status: failure.status };
      if (failure.disposition === 'uncertain') {
        await finishSamsungSyncTarget(ctx, claim, item.countryCode, {
          kind: 'uncertain',
          reason: failure.reason,
          ...status,
        });
        await markWalletClaimUncertain(ctx.env.DB, { ...claim, now: ctx.clock.now() });
        return 'uncertain';
      }
      if (
        op.kind === 'revoke' &&
        error instanceof SamsungNotificationError &&
        error.status === 204
      ) {
        // Provider reports this reference absent in this region; this is acceptance, not proof
        // of a particular holder's device state.
        if (
          !(await finishSamsungSyncTarget(ctx, claim, item.countryCode, {
            kind: 'success',
            status: 204,
          }))
        ) {
          await markWalletClaimUncertain(ctx.env.DB, { ...claim, now: ctx.clock.now() });
          return 'uncertain';
        }
        continue;
      }
      const retryAt =
        failure.disposition === 'retry' ? ctx.clock.now() + (failure.retryAfterMs ?? 1_000) : null;
      await finishSamsungSyncTarget(ctx, claim, item.countryCode, {
        kind: 'failure',
        reason: failure.reason,
        retryAt,
        ...status,
      });
    }
  }
  try {
    await assertCurrent();
  } catch {
    ctx.log.warn('wallet.sync_fence_lost', { code: 'WALLET_SYNC_FENCE' });
    return holdClaim();
  }
  const results = await listSamsungSyncTargets(ctx, claim);
  if (results.some((target) => target.state === 'inflight' || target.state === 'uncertain')) {
    await markWalletClaimUncertain(ctx.env.DB, { ...claim, now: ctx.clock.now() });
    return 'uncertain';
  }
  const pending = results.filter(
    (target) => target.state === 'pending' || target.state === 'retry',
  );
  if (pending.length) {
    const next = Math.min(...pending.map((target) => target.nextAttemptAt ?? ctx.clock.now()));
    return complete(ctx, claim, op, {
      kind: 'failure',
      reason: 'unavailable',
      retryable: true,
      retryAfterMs: Math.max(1_000, next - ctx.clock.now()),
    });
  }
  if (results.some((target) => target.state === 'failed')) {
    return complete(ctx, claim, op, { kind: 'failure', reason: 'rejected', retryable: false });
  }
  return complete(ctx, claim, op, { kind: 'success' });
}
