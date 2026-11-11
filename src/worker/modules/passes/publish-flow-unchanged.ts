import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PublishOptions, PublishResult } from './publish.ts';
import type { PreparedPublishAttempt } from './publish-flow-prepare.ts';
import { assertPublishAuthority, assertReleaseFence } from './publish-service-release.ts';
import { matchesConnectionPass } from './repo-read-connection.ts';
import { getPass } from './repo-read-pass.ts';
import { casMeta } from './repo-write-publish.ts';
import {
  applyPublishConnectionState,
  matchesPublishSnapshot,
} from './repo-write-publish-snapshot.ts';

// Capture both inputs before serializing either one.
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Store input-only changes or revalidate an identical pass without publishing an artifact. */
export async function publishUnchangedAttempt(
  ctx: ServiceContext,
  options: PublishOptions,
  prepared: PreparedPublishAttempt,
): Promise<PublishResult | null> {
  const db = ctx.env.DB;
  const { current, next, artifact, expectedPass, release, requireNoReleaseHistory, scanCode } =
    prepared;
  const { credentialKeysetCommitment } = prepared;
  // Input changes that render the same pass are stored without a version or a push.
  const metaChanged =
    !sameJson(next.personalization, current.personalization) ||
    !sameJson(next.fieldSources, current.fieldSources) ||
    next.externalId !== current.externalId ||
    next.templateVersion !== current.templateVersion ||
    current.contentHash === null ||
    current.scanCode === null;
  if (!metaChanged) {
    if (options.connectionState && options.connectionContext) {
      const state = await applyPublishConnectionState(
        ctx,
        options.connectionContext,
        expectedPass,
        options.connectionState.syncErrorCode,
        options.authority,
        release,
        requireNoReleaseHistory,
      );
      if (!state) {
        if (release || requireNoReleaseHistory)
          await assertReleaseFence(ctx, current, release, requireNoReleaseHistory);
        throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
      }
      return {
        pass: { ...current, syncErrorCode: options.connectionState.syncErrorCode },
        changed: false,
        credentialKeysetCommitment,
      };
    }
    if (options.connectionContext && !(await matchesConnectionPass(db, options.connectionContext)))
      throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
    if (
      !(await matchesPublishSnapshot(
        db,
        expectedPass,
        options.connectionContext,
        options.authority,
        options.authority ? ctx.clock.now() : undefined,
        false,
        release,
        requireNoReleaseHistory,
      ))
    ) {
      if (release || requireNoReleaseHistory)
        await assertReleaseFence(ctx, current, release, requireNoReleaseHistory);
      throw new ConflictError(
        'The pass or your access changed. Reload and retry.',
        'PASS_CONFLICT',
      );
    }
    return { pass: current, changed: false, credentialKeysetCommitment };
  }
  const written = await casMeta(ctx, current.id, current.version, {
    personalization: next.personalization,
    fieldSources: next.fieldSources,
    externalId: next.externalId,
    templateVersion: next.templateVersion,
    release,
    requireNoReleaseHistory,
    contentHash: artifact.contentHash,
    barcodeHash: artifact.barcodeHash,
    lookupHash: artifact.lookupHash,
    scanCode,
    objectKey: current.objectKey,
    expectedPass,
    connectionContext: options.connectionContext,
    connectionState: options.connectionState,
    authority: options.authority,
    holder: options.holder,
    clock: ctx.clock,
  });
  if (written === null) {
    if (release || requireNoReleaseHistory)
      await assertReleaseFence(ctx, current, release, requireNoReleaseHistory);
    if (options.connectionContext)
      throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
    if (options.authority) await assertPublishAuthority(ctx, options.authority);
    if (options.expectedPass || options.expectedRemoval)
      throw new ConflictError('The staged pass changed. Reload and retry.', 'PASS_CONFLICT');
    if (options.expectedVersion !== undefined) throw new PreconditionFailedError();
    return null;
  }
  const pass = await getPass(db, current.id);
  if (
    options.connectionContext &&
    (!pass ||
      pass.version !== written ||
      pass.linkGeneration !== current.linkGeneration ||
      pass.identityId !== current.identityId ||
      pass.credentialGeneration !== current.credentialGeneration ||
      pass.lifecycleGeneration !== current.lifecycleGeneration ||
      pass.holderEmail !== current.holderEmail ||
      pass.ownerUserId !== current.ownerUserId ||
      pass.serial !== current.serial ||
      pass.authToken !== current.authToken)
  )
    throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
  return { pass: pass ?? current, changed: false, credentialKeysetCommitment };
}
