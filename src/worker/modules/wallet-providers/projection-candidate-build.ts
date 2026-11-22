import { statusLabel } from '../../../passkit/wallets/fidelity.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { candidateHash } from '../templates/release-content.ts';
import type { VersionRow } from '../templates/repo.ts';
import {
  getWalletProviderReadiness,
  readConfiguredWalletProviderCredentials,
} from './account-service.ts';
import {
  identityCardType,
  type NativeProjection,
  type ProjectionV2,
  type ProjectionV2Request,
  parseProjectionInput,
  projectionPolicy,
  providerIdentityHash,
} from './projection-contract.ts';
import { computeProjectionPins, samePins, unreleasable } from './projection-pins.ts';
import { changed } from './projection-service-support.ts';
import { assertProjectionSource, verifiedAppleSource } from './projection-source.ts';
import {
  type ProjectionCandidate,
  type ProjectionScope,
  projectionCandidateEnvelope,
} from './repo-projection-store.ts';

/**
 * Schema 2: the server compiles the version. The author names the omissions it has (and may send
 * the pins it saw); anything that no longer matches is a stale review.
 */
async function pinnedProjection(
  ctx: ServiceContext,
  version: VersionRow,
  named: ProjectionV2Request | ProjectionV2,
): Promise<ProjectionV2> {
  const { pins, report } = await computeProjectionPins(ctx, named.provider, version);
  if (unreleasable(report))
    throw new ConflictError(statusLabel(report.status), 'WALLET_PROJECTION_BLOCKED');
  const omissions = [...new Set(named.approvedOmissions)].sort();
  if (
    canonicalJson(omissions) !== canonicalJson(pins.approvedOmissions) ||
    ('report' in named && !samePins(named, pins))
  )
    throw changed();
  return pins;
}

/**
 * A candidate for one Apple source release and one provider account, ready to insert. Who authors
 * it (a member or the system) is the caller's; the source, account and pins are checked the same.
 */
export async function buildProjectionCandidate(
  ctx: ServiceContext,
  scope: ProjectionScope,
  input: { sourceReleaseId: string; version: string; projection: unknown; authorId: string },
  credentialKeysetCommitment: string,
): Promise<ProjectionCandidate> {
  const named = parseProjectionInput(input.projection);
  if (named.provider !== scope.provider) throw new ValidationError();
  const source = await verifiedAppleSource(ctx, {
    ...scope,
    sourceReleaseId: input.sourceReleaseId,
    version: input.version,
  });
  if (!source) throw changed();
  let projection: NativeProjection;
  if (named.schema === 2) projection = await pinnedProjection(ctx, source.version, named);
  else {
    projection = named;
    assertProjectionSource(projection, source.version);
  }
  const accountScope = { orgId: scope.orgId, mode: scope.mode, provider: scope.provider };
  const readiness = await getWalletProviderReadiness(ctx, accountScope);
  if (!readiness.accountId || readiness.state === 'revoked' || readiness.state === 'absent')
    throw changed();
  const account = await readConfiguredWalletProviderCredentials(ctx, accountScope, {
    accountId: readiness.accountId,
    accountRevision: readiness.revision,
  });
  if (!account || account.provider !== scope.provider) throw changed();
  const policy = projectionPolicy(scope.provider);
  const candidate: ProjectionCandidate = {
    ...scope,
    credentialKeysetCommitment,
    id: ctx.ids.id(),
    version: input.version,
    contentHash: source.release.contentHash,
    candidateHash: '',
    adapterRevision: policy.adapterRevision,
    adapterCapabilities: [...policy.adapterCapabilities],
    audiencePolicyRevision: policy.audiencePolicyRevision,
    authorId: input.authorId,
    versionAuthorId: source.version.createdBy,
    createdAt: ctx.clock.now(),
    sourceReleaseId: source.release.id,
    sourceReleaseGeneration: source.release.generation,
    sourceReleaseHash: source.release.candidateHash,
    accountId: account.accountId,
    accountRevision: account.revision,
    accountEpoch: account.authorityEpoch,
    providerIdentityHash: await providerIdentityHash(account, identityCardType(projection)),
    projection,
  };
  candidate.candidateHash = await candidateHash(projectionCandidateEnvelope(candidate));
  return candidate;
}
