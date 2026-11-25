import { stampInput } from '../../../passkit/behaviors/term/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { withoutPersonalizationFiles } from '../apple/personalize-files.ts';
import { assertAccessInput } from './access-input.ts';
import { type BuildRequest, buildArtifact } from './builder.ts';
import { credentialTombstoneRef } from './credential-tombstones.ts';
import type { PublishOptions } from './publish.ts';
import { artifactCredentialRefs, type PublishAttempt } from './publish-service-artifact.ts';
import {
  type AppleRelease,
  assertReleaseArtifact,
  releaseChanged,
  resolvePublishRelease,
} from './publish-service-release.ts';
import type { Pass } from './repo-map.ts';
import type { PublishReads } from './repo-read-publish-bundle.ts';
import type { PublishRemovalSnapshot } from './repo-write-publish-snapshot.ts';
import { newScanCode, primaryBarcodeMessage } from './scan-code.ts';
import { sameAsRender } from './timed-variant.ts';

export interface PublishReleaseState {
  capturedRelease: AppleRelease | undefined;
  capturedNoReleaseHistory: boolean;
}

interface PublishBuildSnapshot {
  current: Pass;
  reads: PublishReads;
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
  /** Identical only through the current timed render: the artifact's `contentHash` stays. */
  asRendered: boolean;
  /** A new scan code: the keyed hash of the code it replaces. */
  rotation: { oldCodeHash: string } | undefined;
}

export async function preparePublishAttempt(
  ctx: ServiceContext,
  options: PublishOptions,
  snapshot: PublishBuildSnapshot,
  state: PublishReleaseState,
  credentialEnv: object,
  credentialKeysetCommitment: string,
): Promise<PreparedPublishAttempt> {
  const { current, removalSnapshot, reads } = snapshot;
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
  const requireNoReleaseHistory = false;
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
  }
  // Re-rendering a pass at its own version is use, not issuance: it needs no head, so a newer,
  // withdrawn or missing release (archived template) never refuses it.
  const org = reads.org;
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  // Once Wallet has personalized the pass, personalization.json must stay out of every build.
  const buildCtx = reads.personalized ? withoutPersonalizationFiles(ctx) : ctx;
  const previousJson = reads.previousJson;
  const previous = options.notify === undefined ? null : previousJson;
  // Older passes get their scan code on the first publish after it was introduced.
  const scanCode = options.rotateScanCode
    ? newScanCode(ctx)
    : (current.scanCode ?? newScanCode(ctx));
  const rotation =
    options.rotateScanCode && current.scanCode
      ? {
          oldCodeHash: await credentialTombstoneRef(
            credentialEnv,
            current.orgId,
            current.mode,
            await sha256Hex(current.scanCode),
          ),
        }
      : undefined;
  const removalAt = removalSnapshot.at;
  const removal = removalAt !== null ? removalSnapshot : null;
  const buildRequest = {
    orgId: current.orgId,
    orgName: org.name,
    personal: org.personal,
    branding: org.branding,
    ...(options.notify === undefined
      ? {}
      : {
          changeMessages: {
            previous: previous ? (JSON.parse(previous) as PassJson) : null,
            notify: options.notify,
            ...(options.changeText === undefined
              ? {}
              : {
                  text:
                    typeof options.changeText === 'function'
                      ? options.changeText(next.personalization)
                      : options.changeText,
                }),
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
    prefetched: {
      identityRow: reads.identityRow,
      inputs: reads.inputs,
      authSeal: reads.authSeal,
    },
  };
  let artifact = await buildArtifact(buildCtx, buildRequest);
  // A term that starts at issue gets its start stamped once, into the input, so a rebuild never moves it.
  const issueInput = stampInput(artifact.template.manifest, 'issue');
  const issueValue = issueInput ? next.personalization[issueInput] : undefined;
  if (
    issueInput &&
    (issueValue === undefined || issueValue === null || issueValue === '') &&
    next.fieldSources[issueInput] !== 'connection'
  ) {
    next.personalization = {
      ...next.personalization,
      [issueInput]: new Date(ctx.clock.now()).toISOString(),
    };
    next.fieldSources = { ...next.fieldSources, [issueInput]: 'manual' };
    buildRequest.personalization = next.personalization;
    artifact = await buildArtifact(buildCtx, buildRequest);
  }
  assertReleaseArtifact(release, artifact.template);
  if (options.rotateScanCode && primaryBarcodeMessage(artifact.passJson) !== scanCode)
    throw new ConflictError(
      "This pass's barcode is not its scan code, so a new code cannot replace it.",
      'NEW_CODE_UNSUPPORTED',
    );
  // Every publish that changes the input is held to the Access card's rules (AX 2.4), whoever asks.
  if (JSON.stringify(next.personalization) !== JSON.stringify(current.personalization))
    await assertAccessInput(ctx, current.orgId, artifact.template, next.personalization);
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
  const same = !options.force && next.status === current.status;
  const asRendered =
    same && !sameContent && (await sameAsRender(ctx, current, artifact, previousParsed));
  const identical = same && (sameContent || asRendered);
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
    asRendered,
    rotation,
  };
}
