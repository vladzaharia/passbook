import { AppError, ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PublishOptions } from './publish.ts';
import type { PreparedPublishAttempt } from './publish-flow-prepare.ts';
import { assertPublishAuthority, assertReleaseFence } from './publish-service-release.ts';
import { casPublish } from './repo-write-publish.ts';

/** Put the built object before its guarded version write, retaining it on ambiguous D1 failure. */
export async function commitPublishArtifact(
  ctx: ServiceContext,
  options: PublishOptions,
  prepared: PreparedPublishAttempt,
  attempt: number,
): Promise<number | null> {
  const { current, next, artifact, expectedPass, release, requireNoReleaseHistory, scanCode } =
    prepared;
  const now = ctx.clock.now();
  const objectKey = `passes/${current.id}/v${current.version + 1}-${ctx.ids.token(6)}.pkpass`;
  await ctx.env.BUCKET.put(objectKey, artifact.bytes, {
    httpMetadata: { contentType: 'application/vnd.apple.pkpass' },
  });
  let written: number | null;
  try {
    let publishedRemovalGeneration: number | undefined;
    if (options.source === 'remove') {
      if (!options.expectedRemoval)
        throw new ConflictError(
          'The staged removal context is missing. Reload and retry.',
          'PASS_CONFLICT',
        );
      publishedRemovalGeneration = options.expectedRemoval.generation;
    }
    written = await casPublish(ctx, {
      id: current.id,
      expectedVersion: current.version,
      previousModifiedAt: current.modifiedAt,
      now,
      templateVersion: next.templateVersion,
      release,
      requireNoReleaseHistory,
      personalization: next.personalization,
      fieldSources: next.fieldSources,
      displayTitle: artifact.title,
      displaySubtitle: artifact.subtitle,
      externalId: next.externalId,
      status: next.status,
      objectKey,
      objectSha256: artifact.sha256,
      objectSize: artifact.bytes.length,
      contentHash: artifact.contentHash,
      cause: options.cause,
      source: options.source ?? null,
      actorType: options.actor.type,
      actorId: options.actor.id,
      passJson: prepared.passJson,
      barcodeHash: artifact.barcodeHash,
      lookupHash: artifact.lookupHash,
      scanCode,
      expectedPass,
      publishedRemovalGeneration,
      connectionContext: options.connectionContext,
      connectionState: options.connectionState,
      authority: options.authority,
      holder: options.holder,
      clock: ctx.clock,
    });
  } catch (error) {
    // A grant refusal is a definite rollback: nothing committed, so the object can go.
    if (error instanceof AppError) {
      await ctx.env.BUCKET.delete(objectKey);
      throw error;
    }
    // Ambiguous D1 failure: the commit may have succeeded, so the object stays.
    ctx.log.error('pass.publish_failed', { passId: current.id, code: 'PUBLISH_D1', error });
    throw error;
  }
  if (written === null) {
    await ctx.env.BUCKET.delete(objectKey);
    if (release || requireNoReleaseHistory)
      await assertReleaseFence(ctx, current, release, requireNoReleaseHistory);
    if (options.connectionContext)
      throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
    if (options.authority) await assertPublishAuthority(ctx, options.authority);
    if (options.expectedPass || options.expectedRemoval)
      throw new ConflictError('The staged pass changed. Reload and retry.', 'PASS_CONFLICT');
    if (options.expectedVersion !== undefined) throw new PreconditionFailedError();
    ctx.log.info('pass.publish_conflict', { passId: current.id, attempt });
    return null;
  }
  return written;
}
