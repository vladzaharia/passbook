import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  TemplateCandidate,
  TemplateRelease,
  TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import { type AuthContext, modeOf } from '../../platform/auth.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertTemplateAuthority } from '../templates/access.ts';
import { candidateHash } from '../templates/release-content.ts';
import { getVersion } from '../templates/repo.ts';
import type { ApprovalRow, ReleaseRow } from '../templates/repo-releases.ts';
import { loadTemplate } from '../templates/service.ts';
import {
  readConfiguredWalletProviderCredentials,
  snapshotWalletCredentialContext,
  type WalletProviderCredentialSnapshot,
} from './account-service.ts';
import {
  identityCardType,
  type NativeProjection,
  type NativeProvider,
  NativeProviderSchema,
  projectionPolicy,
  providerIdentityHash,
} from './projection-contract.ts';
import {
  type ComputedProjection,
  carriesForward,
  computeProjectionPins,
  samePins,
  unreleasable,
  walletsHash,
} from './projection-pins.ts';
import { assertProjectionSource, verifiedAppleSource } from './projection-source.ts';
import { isSelfAuthored, type ProjectionAuthority } from './projection-system-authority.ts';
import { recordProjectionArt, recordProjectionArtFiles } from './repo-projection-art.ts';
import {
  getProjectionCandidate,
  type ProjectionCandidate,
  type ProjectionScope,
  projectionCandidateEnvelope,
} from './repo-projection-store.ts';

export interface ApprovedProjectionScope {
  orgId: string;
  mode: Mode;
  provider: NativeProvider;
  templateId: string;
  templateVersion: string;
  appleReleaseId: string;
  adapterRevision?: number;
  audiencePolicyRevision?: number;
}
export interface ApprovedProjection {
  release: TemplateRelease & {
    sourceReleaseId: string;
    sourceReleaseGeneration: number;
    sourceReleaseHash: string;
    accountId: string;
    accountRevision: number;
    accountEpoch: number;
    providerIdentityHash: string;
  };
  projection: NativeProjection;
}

export const changed = () =>
  new ConflictError(
    'The wallet projection, source release or provider account changed.',
    'WALLET_PROJECTION_CONFLICT',
  );
export const schemaRefused = (provider: NativeProvider) =>
  new ConflictError(
    provider === 'google'
      ? 'Create a new candidate: Google releases use the compiled wallet format.'
      : 'Samsung releases are not open yet.',
    'WALLET_PROJECTION_SCHEMA',
  );
const missing = () =>
  new NotFoundError('Wallet projection candidate not found.', 'WALLET_PROJECTION_NOT_FOUND');

/** Keep the same KEK bindings through every asynchronous read and final SQL fence. */
export function pinProjectionContext(ctx: ServiceContext): ServiceContext {
  const pinned = snapshotWalletCredentialContext(ctx);
  return { ...pinned, env: Object.freeze(pinned.env) };
}

export function nativeScope(templateId: string, scope: TemplateReleaseScope): ProjectionScope {
  const provider = NativeProviderSchema.safeParse(scope.provider);
  if (!provider.success) throw new ValidationError();
  return { templateId, orgId: scope.orgId, mode: scope.mode, provider: provider.data };
}
export async function scopedTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  scope: TemplateReleaseScope,
): Promise<void> {
  if (modeOf(auth) !== scope.mode)
    throw new ForbiddenError(
      'The requested mode does not match the current session.',
      'TEMPLATE_MODE_MISMATCH',
    );
  await loadTemplate(ctx, auth, templateId, scope.orgId);
}
export async function failedWrite(
  ctx: ServiceContext,
  authority: ProjectionAuthority,
): Promise<never> {
  if (authority.kind !== 'system') await assertTemplateAuthority(ctx, authority);
  throw changed();
}
export function candidateDto(
  row: ProjectionCandidate,
  approvals: ApprovalRow[],
  /** The caller, when a person: the list says whether approving this would be their own work. */
  viewerId?: string,
): TemplateCandidate {
  const { credentialKeysetCommitment: _credentialKeysetCommitment, ...candidate } = row;
  return {
    ...candidate,
    approvals: approvals.map((a) => ({ ...a })),
    ...(viewerId ? { selfAuthored: isSelfAuthored(viewerId, row) } : {}),
  };
}
export function releaseDto(
  row: ReleaseRow,
  candidate: ProjectionCandidate,
): ApprovedProjection['release'] {
  return {
    id: row.id,
    templateId: row.templateId,
    orgId: row.orgId,
    mode: row.mode,
    provider: row.provider,
    version: row.version,
    generation: row.generation,
    candidateHash: row.candidateHash,
    source: row.source,
    action: row.action,
    previousReleaseId: row.previousReleaseId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    candidateId: row.candidateId,
    approvalId: row.approvalId,
    sourceReleaseId: candidate.sourceReleaseId,
    sourceReleaseGeneration: candidate.sourceReleaseGeneration,
    sourceReleaseHash: candidate.sourceReleaseHash,
    accountId: candidate.accountId,
    accountRevision: candidate.accountRevision,
    accountEpoch: candidate.accountEpoch,
    providerIdentityHash: candidate.providerIdentityHash,
  };
}
export function sameScope(candidate: ProjectionCandidate, scope: ProjectionScope): boolean {
  return (
    candidate.templateId === scope.templateId &&
    candidate.orgId === scope.orgId &&
    candidate.mode === scope.mode &&
    candidate.provider === scope.provider
  );
}

/** Recompute all mutable external content and the entire immutable approval envelope. */
export async function verifiedCandidate(
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
): Promise<boolean> {
  const policy = projectionPolicy(candidate.provider);
  if (
    candidate.adapterRevision !== policy.adapterRevision ||
    candidate.audiencePolicyRevision !== policy.audiencePolicyRevision ||
    JSON.stringify(candidate.adapterCapabilities) !== JSON.stringify(policy.adapterCapabilities) ||
    (await candidateHash(projectionCandidateEnvelope(candidate))) !== candidate.candidateHash
  )
    return false;
  const source = await verifiedAppleSource(ctx, {
    orgId: candidate.orgId,
    mode: candidate.mode,
    templateId: candidate.templateId,
    sourceReleaseId: candidate.sourceReleaseId,
    version: candidate.version,
  });
  if (
    !source ||
    source.release.generation !== candidate.sourceReleaseGeneration ||
    source.release.candidateHash !== candidate.sourceReleaseHash ||
    source.release.contentHash !== candidate.contentHash ||
    source.version.createdBy !== candidate.versionAuthorId
  )
    return false;
  let account: WalletProviderCredentialSnapshot | null;
  try {
    account = await readConfiguredWalletProviderCredentials(
      ctx,
      {
        orgId: candidate.orgId,
        mode: candidate.mode,
        provider: candidate.provider,
      },
      { accountId: candidate.accountId, authorityEpoch: candidate.accountEpoch },
    );
  } catch (error) {
    if (error instanceof UnavailableError) return false;
    throw error;
  }
  if (
    !account ||
    account.provider !== candidate.provider ||
    account.accountId !== candidate.accountId ||
    account.authorityEpoch !== candidate.accountEpoch ||
    (await providerIdentityHash(account, identityCardType(candidate.projection))) !==
      candidate.providerIdentityHash
  )
    return false;
  if (candidate.projection.schema === 2)
    return candidate.projection.wallets === (await walletsHash(source.version.manifest.wallets));
  try {
    assertProjectionSource(candidate.projection, source.version);
  } catch (error) {
    if (error instanceof ConflictError) return false;
    throw error;
  }
  return true;
}

/** `exact`: review, approval and publication. `carry`: rollback, which reuses an approval (Q21). */
export type PinRule = 'exact' | 'carry';

/**
 * Review, approval and publication need the pins exactly as they are now: a pipeline, report or
 * type that moved since the candidate was made re-opens review (architecture 4.3). Rollback
 * restores something already approved, so it only needs the Q21 rule: same type, no omission
 * beyond the approved ones, still releasable.
 */
function pinsAcceptable(
  candidate: ProjectionCandidate,
  current: ComputedProjection,
  rule: PinRule,
): boolean {
  if (candidate.projection.schema !== 2) return true;
  return rule === 'exact'
    ? !unreleasable(current.report) && samePins(current.pins, candidate.projection)
    : carriesForward(candidate.projection, current);
}
async function currentPins(
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
  rule: PinRule,
): Promise<boolean> {
  if (candidate.projection.schema !== 2) return true;
  const version = await getVersion(ctx.env.DB, candidate.templateId, candidate.version);
  if (!version) return false;
  return pinsAcceptable(
    candidate,
    await computeProjectionPins(ctx, candidate.provider, version, 'dry', candidate.orgId),
    rule,
  );
}
/** Publication: writes the art copies, then records them so a purge can find them. */
export async function storeReleaseArt(
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
  rule: PinRule,
): Promise<void> {
  if (candidate.projection.schema !== 2) return;
  const version = await getVersion(ctx.env.DB, candidate.templateId, candidate.version);
  if (!version) throw changed();
  const current = await computeProjectionPins(
    ctx,
    candidate.provider,
    version,
    'store',
    candidate.orgId,
  );
  if (!pinsAcceptable(candidate, current, rule)) throw changed();
  await recordProjectionArt(ctx.env.DB, {
    candidateId: candidate.id,
    hashes: [...current.art.hashes],
    now: ctx.clock.now(),
  });
  // Claims read this instead of cutting the images again.
  const files = [...current.art.urls].flatMap(([asset, url]) => {
    const sha256 = /\/w\/i\/([0-9a-f]{64})\.png$/.exec(url)?.[1];
    const size = current.art.sizes.get(asset);
    return sha256 && size ? [{ asset, sha256, ...size }] : [];
  });
  await recordProjectionArtFiles(ctx.env.DB, { candidateId: candidate.id, files });
}
export async function scopedCandidate(
  ctx: ServiceContext,
  scope: ProjectionScope,
  id: string,
  hash: string,
  rule: PinRule = 'exact',
): Promise<ProjectionCandidate> {
  const candidate = await getProjectionCandidate(ctx.env.DB, id);
  if (!candidate || !sameScope(candidate, scope)) throw missing();
  if (
    candidate.candidateHash !== hash ||
    !(await verifiedCandidate(ctx, candidate)) ||
    !(await currentPins(ctx, candidate, rule))
  )
    throw changed();
  return candidate;
}
