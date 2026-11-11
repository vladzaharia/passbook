import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { buildArtifact } from './builder.ts';
import { notifiesHolder, overBudget, pushBudgetOf } from './change-messages.ts';
import type { PublishOptions, PublishResult } from './publish.ts';
import { commitPublishArtifact } from './publish-flow-commit.ts';
import { completePublishAttempt } from './publish-flow-complete.ts';
import type { PreparedPublishAttempt } from './publish-flow-prepare.ts';
import { artifactCredentialRefs } from './publish-service-artifact.ts';
import { assertReleaseArtifact, assertReleaseFence } from './publish-service-release.ts';
import { matchesPublishSnapshot } from './repo-write-publish-snapshot.ts';

/** Apply notification limits and revalidate the build before putting and committing its artifact. */
export async function publishChangedAttempt(
  ctx: ServiceContext,
  options: PublishOptions,
  prepared: PreparedPublishAttempt,
  credentialEnv: object,
  attempt: number,
): Promise<PublishResult | null> {
  const { current, next, release, requireNoReleaseHistory, scanCode } = prepared;
  // Push budget: a publish that would notify past the daily limit is rebuilt without messages.
  // A removal is exempt: its message is the holder's only notice, and the silent rebuild would
  // still carry it (it is applied after the strip), so the result would claim silence wrongly.
  let silenced = false;
  if (
    !prepared.removal &&
    notifiesHolder(prepared.artifact.passJson, prepared.previousParsed) &&
    overBudget(await pushBudgetOf(ctx, current.id))
  ) {
    prepared.artifact = await buildArtifact(prepared.buildCtx, {
      ...prepared.buildRequest,
      silent: true,
    });
    assertReleaseArtifact(release, prepared.artifact.template);
    prepared.expectedPass = {
      ...prepared.expectedPass,
      credentialRefs: await artifactCredentialRefs(
        credentialEnv,
        current,
        prepared.artifact,
        next.personalization,
        scanCode,
      ),
    };
    prepared.passJson = JSON.stringify(prepared.artifact.passJson);
    silenced = true;
  }
  if (
    !(await matchesPublishSnapshot(
      ctx.env.DB,
      prepared.expectedPass,
      options.connectionContext,
      undefined,
      undefined,
      options.source === 'remove',
      release,
      requireNoReleaseHistory,
      next.templateVersion,
    ))
  ) {
    if (release || requireNoReleaseHistory)
      await assertReleaseFence(ctx, current, release, requireNoReleaseHistory);
    if (options.connectionContext)
      throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
    if (options.expectedPass || options.expectedRemoval)
      throw new ConflictError('The staged pass changed. Reload and retry.', 'PASS_CONFLICT');
    if (options.expectedVersion !== undefined) throw new PreconditionFailedError();
    return null;
  }
  const written = await commitPublishArtifact(ctx, options, prepared, attempt);
  if (written === null) return null;
  return completePublishAttempt(ctx, options, prepared, written, silenced);
}
