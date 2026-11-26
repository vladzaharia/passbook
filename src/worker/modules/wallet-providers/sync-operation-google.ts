import type { PassJson } from '../../../passkit/types.ts';
import { withMessageHistory } from '../../../passkit/wallets/google/messages.ts';
import type { GoogleObjectCommon } from '../../../passkit/wallets/google/types.ts';
import { currentPassJson, getPass } from '../passes/repo-read-pass.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { googleCallbackClassProjection } from './google-callback-binding.ts';
import { refreshGoogleClassReview } from './google-class-review.ts';
import { compileGooglePass, projectionGoogleType } from './google-compile.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import { markWalletClaimUncertain } from './instance.ts';
import { getApprovedProjection } from './projection-service.ts';
import { renderGoogleProjection } from './render-projection.ts';
import { getGoogleBindingClass, hadSucceededUpsert } from './repo-google-class.ts';
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
import { prepareGoogleMessages, sendGoogleMessage } from './sync-operation-google-messages.ts';
import { completeWalletSyncOperation as complete } from './sync-operation-retirement.ts';

export async function runGoogleWalletProviderOperation(
  execution: WalletSyncOperationExecution,
  binding: WalletSyncOperationBinding,
  retirement: WalletRetirementClaim,
): Promise<WalletSyncRunResult> {
  const { ctx, claim, op, assertCurrent, onProviderResponse, holdClaim } = execution;
  let providerStarted = false;
  let confirmed: 'inactive' | 'absent' | undefined;
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
      const issued = await getGoogleBindingClass(ctx.env.DB, op.instanceId);
      confirmed = await inactivateGoogleRuntimeObject(ctx, binding.scope, {
        ...identity,
        ...(binding.original.projection.schema === 2 ? { type } : {}),
        ...(issued ? { classIdHash: issued.classIdHash } : {}),
        retirement,
      });
      // Anomalous: an object we wrote is gone. It settles (a link cannot recreate it), but it is not routine.
      if (confirmed === 'absent' && (await hadSucceededUpsert(ctx.env.DB, op.instanceId)))
        ctx.log.warn('wallet.google_revoke_absent_after_upsert', {
          code: 'WALLET_GOOGLE_REVOKE_ABSENT_AFTER_UPSERT',
          orgId: op.orgId,
        });
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
        const own = found?.orgId === op.orgId && found.mode === op.mode ? found : null;
        const candidateId = approved.release.candidateId;
        const compiled =
          own && candidateId
            ? await compileGooglePass(ctx, own, approved.projection, candidateId)
            : 'unreadable';
        if (compiled === 'art_missing') {
          // Publication stored the art; rebuild it and let the claim retry.
          await ctx.env.JOBS.send({ kind: 'wallet.google_art', candidateId: candidateId ?? '' });
          return complete(ctx, claim, op, {
            kind: 'failure',
            reason: 'unavailable',
            retryable: true,
          });
        }
        const issued = await getGoogleBindingClass(ctx.env.DB, op.instanceId);
        if (
          typeof compiled === 'string' ||
          binding.original.projection.schema !== 2 ||
          type !== compiled.type ||
          // A class key that changed after issue would name another class: refused like a type change.
          (issued !== null && (issued.classKey ?? undefined) !== compiled.classKey)
        ) {
          // Not a provider fault, and a class is never reassociated: keep the original binding.
          ctx.log.warn('wallet.google_compile_refused', {
            code: 'WALLET_GOOGLE_COMPILE',
            orgId: op.orgId,
            reason:
              typeof compiled === 'string'
                ? compiled
                : type !== compiled.type
                  ? 'type_changed'
                  : 'class_key_changed',
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
        const messageIdentity = {
          releaseId: op.identityProjectionReleaseId,
          passId: op.passId,
          credentialGeneration: op.credentialGeneration,
          channelEpoch: op.channelEpoch,
          ...partition,
        };
        const prepared = await prepareGoogleMessages(execution, binding.scope, messageIdentity);
        const classResult = await upsertGoogleRuntimeClass(ctx, binding.scope, {
          releaseId: op.identityProjectionReleaseId,
          ...partition,
          writer: {
            releaseId: approved.release.id,
            releaseGeneration: approved.release.generation,
          },
          projection: { ...compiled.classBody, ...callback },
          assertCurrent,
          onProviderResponse,
        });
        if (classResult === 'drift')
          ctx.log.warn('wallet.google_class_drift', {
            code: 'GOOGLE_CLASS_DRIFT',
            orgId: op.orgId,
          });
        await assertCurrent();
        await upsertGoogleRuntimeObject(ctx, binding.scope, {
          ...identity,
          ...partition,
          // PassBook owns the object's `messages` (decision 3): the delivered history, or the voided message.
          // A message in doubt may be on the card: with it unresolved, `messages` is left out of the write.
          projection:
            prepared.blocked && (passJson as PassJson | null)?.voided !== true
              ? compiled.objectBody
              : (withMessageHistory(
                  compiled.objectBody as unknown as GoogleObjectCommon,
                  prepared.history,
                  (passJson as PassJson | null)?.voided === true,
                  ctx.clock.now(),
                ) as unknown as GoogleGenericProjection),
        });
        // Object first, message second: a message failure never fails the write it describes.
        await sendGoogleMessage(execution, binding.scope, messageIdentity, prepared);
        const settled = await complete(ctx, claim, op, { kind: 'success' });
        // Google's review of the class is read after the write, off this run's budget; a failure is logged.
        ctx.waitUntil(
          refreshGoogleClassReview(ctx, binding.scope, {
            releaseId: op.identityProjectionReleaseId,
            ...partition,
          }),
        );
        return settled;
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
      confirmed ? { kind: 'success', confirmed } : { kind: 'success' },
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
