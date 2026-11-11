import type { PassJson } from '../../../passkit/types.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { withoutPersonalizationFiles } from '../apple/personalize-files.ts';
import { isPersonalized } from '../apple/repo-personalize.ts';
import { type BuildRequest, buildArtifact } from './builder.ts';
import type { PublishOptions } from './publish.ts';
import { artifactCredentialRefs, type PublishAttempt } from './publish-service-artifact.ts';
import {
  type AppleRelease,
  assertReleaseArtifact,
  releaseChanged,
  resolveLegacyRelease,
  resolvePublishRelease,
} from './publish-service-release.ts';
import type { Pass } from './repo-map.ts';
import { getOrg } from './repo-read-issuance.ts';
import { currentPassJson } from './repo-read-pass.ts';
import type { PublishRemovalSnapshot } from './repo-write-publish-snapshot.ts';
import { newScanCode } from './scan-code.ts';

export interface PublishReleaseState {
  capturedRelease: AppleRelease | undefined;
  capturedNoReleaseHistory: boolean;
}

interface PublishBuildSnapshot {
  current: Pass;
  removalSnapshot: PublishRemovalSnapshot & {
    publishedGeneration: number | null;
    imageGeneration: number;
  };
}

export interface PreparedPublishAttempt extends PublishAttempt {
  buildCtx: ServiceContext;
  buildRequest: BuildRequest;
  previousParsed: PassJson | null;
  passJson: string;
  removal: PublishRemovalSnapshot | null;
  identical: boolean;
}

export async function preparePublishAttempt(
  ctx: ServiceContext,
  options: PublishOptions,
  snapshot: PublishBuildSnapshot,
  state: PublishReleaseState,
  credentialEnv: object,
  credentialKeysetCommitment: string,
): Promise<PreparedPublishAttempt> {
  const { current, removalSnapshot } = snapshot;
  const expectedPassBase = {
    ...current,
    removalMessage: removalSnapshot.message,
    removalPriorStatus: removalSnapshot.priorStatus,
    lifecycleGeneration: removalSnapshot.generation,
    removalPublishedGeneration: removalSnapshot.publishedGeneration,
    imageGeneration: removalSnapshot.imageGeneration,
  };
  const mutation = options.mutate?.(current) ?? {};
  const next = {
    personalization: mutation.personalization ?? current.personalization,
    fieldSources: mutation.fieldSources ?? current.fieldSources,
    templateVersion: mutation.templateVersion ?? current.templateVersion,
    status: mutation.status ?? current.status,
    externalId: mutation.externalId === undefined ? current.externalId : mutation.externalId,
  };
  if (options.source === 'remove' && next.status !== 'voided')
    throw new ConflictError('The staged removal changed. Reload and retry.', 'PASS_CONFLICT');
  let release: AppleRelease | undefined;
  let requireNoReleaseHistory = false;
  if (
    next.templateVersion !== current.templateVersion ||
    options.expectedRelease !== undefined ||
    state.capturedRelease !== undefined
  ) {
    if (state.capturedNoReleaseHistory) throw releaseChanged();
    release = await resolvePublishRelease(
      ctx,
      current,
      next.templateVersion,
      options.expectedRelease,
      state.capturedRelease,
    );
    state.capturedRelease ??= release;
  } else if (current.releaseId === null) {
    const approved = await resolveLegacyRelease(ctx, current);
    if (approved) {
      if (state.capturedNoReleaseHistory) throw releaseChanged();
      release = approved;
      state.capturedRelease = approved;
    } else {
      requireNoReleaseHistory = true;
      state.capturedNoReleaseHistory = true;
    }
  }
  const db = ctx.env.DB;
  const org = await getOrg(db, current.orgId);
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  // Once Wallet has personalized the pass, personalization.json must stay out of every build.
  const buildCtx = (await isPersonalized(db, current.id)) ? withoutPersonalizationFiles(ctx) : ctx;
  const previousJson = await currentPassJson(db, current.id);
  const previous = options.notify === undefined ? null : previousJson;
  // Older passes get their scan code on the first publish after it was introduced.
  const scanCode = current.scanCode ?? newScanCode(ctx);
  const removalAt = removalSnapshot.at;
  const removal = removalAt !== null ? removalSnapshot : null;
  const buildRequest = {
    orgId: current.orgId,
    orgName: org.name,
    branding: org.branding,
    ...(options.notify === undefined
      ? {}
      : {
          changeMessages: {
            previous: previous ? (JSON.parse(previous) as PassJson) : null,
            notify: options.notify,
          },
        }),
    ...(removalAt !== null ? { removal: { at: removalAt, message: removalSnapshot.message } } : {}),
    passId: current.id,
    scanCode,
    serial: current.serial,
    authToken: current.authToken,
    webServiceUrl: current.webServiceUrl,
    identityId: current.identityId,
    templateId: current.templateId,
    templateVersion: next.templateVersion,
    personalization: next.personalization,
    status: next.status,
  };
  const artifact = await buildArtifact(buildCtx, buildRequest);
  assertReleaseArtifact(release, artifact.template);
  const expectedPass = {
    ...expectedPassBase,
    credentialKeysetCommitment,
    credentialRefs: await artifactCredentialRefs(
      credentialEnv,
      current,
      artifact,
      next.personalization,
      scanCode,
    ),
  };
  const previousParsed = previousJson ? (JSON.parse(previousJson) as PassJson) : null;
  const passJson = JSON.stringify(artifact.passJson);
  // A template upgrade that leaves pass.json and every asset unchanged is not a new pass:
  // devices must not be pushed (catalog 22). Legacy rows without a hash compare pass.json.
  const sameContent =
    current.contentHash !== null
      ? current.contentHash === artifact.contentHash
      : next.templateVersion === current.templateVersion && previousJson === passJson;
  const identical = !options.force && next.status === current.status && sameContent;
  return {
    current,
    next,
    artifact,
    expectedPass,
    release,
    requireNoReleaseHistory,
    scanCode,
    credentialKeysetCommitment,
    buildCtx,
    buildRequest,
    previousParsed,
    passJson,
    removal,
    identical,
  };
}
