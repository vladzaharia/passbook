import { currentPassJson, getPass } from '../passes/repo-read-pass.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { googleCallbackClassProjection } from './google-callback-binding.ts';
import { compileGooglePass, projectionGoogleType } from './google-compile.ts';
import { markWalletClaimUncertain } from './instance.ts';
import { getApprovedProjection } from './projection-service.ts';
import { renderGoogleProjection } from './render-projection.ts';
import { readPassSnapshot } from './repo-instance.ts';
import {
  inactivateGoogleRuntimeObject,
  upsertGoogleRuntimeClass,
  upsertGoogleRuntimeObject,
  type WalletRetirementClaim,
} from './runtime.ts';
import { classifyWalletSyncFailure } from './sync-errors.ts';
import type {
  WalletSyncOperationBinding,
  WalletSyncOperationExecution,
  WalletSyncRunResult,
} from './sync-operation-context.ts';
import { completeWalletSyncOperation as complete } from './sync-operation-retirement.ts';

export async function runGoogleWalletProviderOperation(
  execution: WalletSyncOperationExecution,
  binding: WalletSyncOperationBinding,
  retirement: WalletRetirementClaim,
): Promise<WalletSyncRunResult> {
  const { ctx, claim, op, assertCurrent, onProviderResponse, holdClaim } = execution;
  let providerStarted = false;
  let confirmed = false;
  try {
    const type = projectionGoogleType(binding.original.projection);
    const identity = {
      releaseId: op.identityProjectionReleaseId,
      passId: op.passId,
      credentialGeneration: op.credentialGeneration,
      channelEpoch: op.channelEpoch,
      assertCurrent,
      onProviderResponse,
    };
    if (op.kind === 'revoke') {
      providerStarted = true;
      // G5: PUT inactive, then GET to confirm. Only a confirmed revoke lets retirement settle.
      await inactivateGoogleRuntimeObject(ctx, binding.scope, {
        ...identity,
        ...(binding.original.projection.schema === 2 ? { type } : {}),
        retirement,
      });
      confirmed = true;
    } else {
      const pass = await readPassSnapshot(ctx.env.DB, op);
      if (!pass?.issuingReleaseId || binding.original.projection.provider !== 'google') {
        return complete(ctx, claim, op, {
          kind: 'failure',
          reason: 'rejected',
          retryable: false,
        });
      }
      const approved = await getApprovedProjection(ctx, {
        orgId: op.orgId,
        mode: op.mode,
        provider: 'google',
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        appleReleaseId: pass.issuingReleaseId,
      });
      const raw = await currentPassJson(ctx.env.DB, op.passId);
      let passJson: unknown;
      try {
        passJson = raw === null ? null : JSON.parse(raw);
      } catch {
        passJson = null;
      }
      if (
        approved?.projection.provider !== 'google' ||
        approved.release.id !== op.projectionReleaseId ||
        approved.release.accountId !== op.accountId ||
        // D2: a same-identity rotation moves the revision, not the epoch.
        (op.accountEpoch === null
          ? approved.release.accountRevision !== op.accountRevision
          : approved.release.accountEpoch !== op.accountEpoch) ||
        approved.release.providerIdentityHash !== binding.original.providerIdentityHash
      ) {
        return complete(ctx, claim, op, {
          kind: 'failure',
          reason: 'rejected',
          retryable: false,
        });
      }
      if (approved.projection.schema === 2) {
        // The compiler is the content (architecture 6): each type has its own class and object.
        const found = await getPass(ctx.env.DB, op.passId);
        const compiled = found
          ? await compileGooglePass(ctx, found, approved.projection)
          : 'unreadable';
        if (
          typeof compiled === 'string' ||
          binding.original.projection.schema !== 2 ||
          type !== compiled.type
        ) {
          // Not a provider fault, and a class is never reassociated: keep the original binding.
          ctx.log.warn('wallet.google_compile_refused', {
            code: 'WALLET_GOOGLE_COMPILE',
            orgId: op.orgId,
            reason: typeof compiled === 'string' ? compiled : 'type_changed',
          });
          return complete(ctx, claim, op, {
            kind: 'failure',
            reason: 'rejected',
            retryable: false,
          });
        }
        const partition = { type, ...(compiled.classKey ? { classKey: compiled.classKey } : {}) };
        await assertCurrent();
        const callback = await googleCallbackClassProjection(ctx, binding.scope, {
          instanceId: op.instanceId,
          passId: op.passId,
          releaseId: op.identityProjectionReleaseId,
          credentialGeneration: op.credentialGeneration,
          channelEpoch: op.channelEpoch,
          operationVersion: op.version,
          classType: type,
          ...(compiled.classKey ? { classKey: compiled.classKey } : {}),
        });
        await assertCurrent();
        providerStarted = true;
        await upsertGoogleRuntimeClass(ctx, binding.scope, {
          releaseId: op.identityProjectionReleaseId,
          ...partition,
          projection: { ...compiled.classBody, ...callback },
          assertCurrent,
          onProviderResponse,
        });
        await assertCurrent();
        await upsertGoogleRuntimeObject(ctx, binding.scope, {
          ...identity,
          ...partition,
          projection: compiled.objectBody,
        });
        return complete(ctx, claim, op, { kind: 'success' });
      }
      const rendered = renderGoogleProjection(approved.projection, passJson);
      const original = renderGoogleProjection(binding.original.projection, passJson);
      if (
        !rendered ||
        !original ||
        canonicalJson(rendered.classProjection) !== canonicalJson(original.classProjection)
      ) {
        // Google class reassociation is not assumed. Keep the original binding for retirement.
        return complete(ctx, claim, op, {
          kind: 'failure',
          reason: 'rejected',
          retryable: false,
        });
      }
      await assertCurrent();
      const callback = await googleCallbackClassProjection(ctx, binding.scope, {
        instanceId: op.instanceId,
        passId: op.passId,
        releaseId: op.identityProjectionReleaseId,
        credentialGeneration: op.credentialGeneration,
        channelEpoch: op.channelEpoch,
        operationVersion: op.version,
      });
      await assertCurrent();
      providerStarted = true;
      await upsertGoogleRuntimeClass(ctx, binding.scope, {
        releaseId: op.identityProjectionReleaseId,
        projection: { ...original.classProjection, ...callback },
        assertCurrent,
        onProviderResponse,
      });
      await assertCurrent();
      await upsertGoogleRuntimeObject(ctx, binding.scope, {
        ...identity,
        projection: rendered.objectProjection,
      });
    }
    return complete(
      ctx,
      claim,
      op,
      confirmed ? { kind: 'success', confirmed: true } : { kind: 'success' },
    );
  } catch (error) {
    if (execution.fenceLost) return holdClaim();
    if (!providerStarted) {
      return complete(ctx, claim, op, { kind: 'failure', reason: 'rejected', retryable: false });
    }
    const failure = classifyWalletSyncFailure('google', op.attempts, error);
    // A lost authority fence does not settle an ambiguous provider transport.
    if (failure.disposition === 'uncertain') {
      await markWalletClaimUncertain(ctx, { ...claim, now: ctx.clock.now() });
      return 'uncertain';
    }
    return complete(ctx, claim, op, {
      kind: 'failure',
      reason: failure.reason,
      retryable: failure.disposition === 'retry',
      ...(failure.retryAfterMs === null ? {} : { retryAfterMs: failure.retryAfterMs }),
      ...(failure.status === null ? {} : { httpStatus: failure.status }),
    });
  }
}
