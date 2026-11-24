import { getRelease } from '../templates/repo-releases.ts';
import { getSamsungRefreshTarget } from './callbacks-ref.ts';
import { markWalletClaimUncertain } from './instance.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';
import {
  beginSamsungSyncTarget,
  ensureSamsungSyncTargets,
  finishSamsungSyncTarget,
  listSamsungSyncTargets,
} from './repo-sync-targets.ts';
import { sendSamsungRuntimeUpdate, type WalletRetirementClaim } from './runtime.ts';
import { SamsungNotificationError } from './samsung.ts';
import { ensureSamsungCardState } from './samsung-verification.ts';
import { classifyWalletSyncFailure } from './sync-errors.ts';
import type {
  WalletSyncOperationBinding,
  WalletSyncOperationExecution,
  WalletSyncRunResult,
} from './sync-operation-context.ts';
import { completeWalletSyncOperation as complete } from './sync-operation-retirement.ts';
import { recordSamsungMessageOutcome } from './sync-samsung-message.ts';
import { samsungOperationState } from './sync-samsung-state.ts';

/** The card of the release being sent, not of the identity: read now, or from its row within five minutes. */
async function samsungUpdateReady(
  ctx: WalletSyncOperationExecution['ctx'],
  op: WalletSyncOperationExecution['op'],
): Promise<boolean> {
  const release = await getRelease(ctx.env.DB, op.projectionReleaseId);
  const candidate = release?.candidateId
    ? await getProjectionCandidate(ctx.env.DB, release.candidateId)
    : null;
  if (candidate?.provider !== 'samsung') return false;
  return ensureSamsungCardState(ctx, candidate);
}

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
  const projection = binding.original.projection;
  const cardType = projection.schema === 1 ? projection.cardType : projection.type;
  // The card of the release being sent must be usable before an update. A revoke is sent
  // regardless, since the door has already denied the pass.
  if (op.kind !== 'revoke' && !(await samsungUpdateReady(ctx, op))) {
    return (await complete(ctx, claim, op, {
      kind: 'failure',
      reason: 'unavailable',
      retryable: true,
    })) === 'completed'
      ? 'deferred'
      : 'uncertain';
  }
  const state = await samsungOperationState(ctx, op);
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
        type: cardType,
        refId: target.refId,
        state,
        attempt,
        assertCurrent,
        onProviderResponse,
        ...(op.kind === 'revoke'
          ? { retirement }
          : { refresh: { instanceId: op.instanceId, operationVersion: op.version } }),
      });
      if (
        !(await finishSamsungSyncTarget(ctx, claim, item.countryCode, {
          kind: 'success',
          ...(execution.lastResponseStatus === null
            ? {}
            : { status: execution.lastResponseStatus }),
        }))
      ) {
        await markWalletClaimUncertain(ctx, { ...claim, now: ctx.clock.now() });
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
        await markWalletClaimUncertain(ctx, { ...claim, now: ctx.clock.now() });
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
          await markWalletClaimUncertain(ctx, { ...claim, now: ctx.clock.now() });
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
    await markWalletClaimUncertain(ctx, { ...claim, now: ctx.clock.now() });
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
  const done = await complete(ctx, claim, op, { kind: 'success' }, state);
  if (done === 'completed' && state !== 'DELETED' && state !== 'CANCELED')
    await recordSamsungMessageOutcome(execution);
  return done;
}
