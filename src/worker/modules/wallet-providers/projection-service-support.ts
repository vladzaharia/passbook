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
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { assertTemplateAuthority, type TemplateAuthority } from '../templates/access.ts';
import { candidateHash } from '../templates/release-content.ts';
import type { ApprovalRow, ReleaseRow } from '../templates/repo-releases.ts';
import { loadTemplate } from '../templates/service.ts';
import {
  readConfiguredWalletProviderCredentials,
  snapshotWalletCredentialContext,
  type WalletProviderCredentialSnapshot,
} from './account-service.ts';
import type { WalletCredentialKeysetProof } from './instance-types.ts';
import {
  type NativeProjection,
  type NativeProvider,
  NativeProviderSchema,
  projectionPolicy,
  providerIdentityHash,
} from './projection-contract.ts';
import { assertProjectionSource, verifiedAppleSource } from './projection-source.ts';
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
export interface ApprovedProjection extends WalletCredentialKeysetProof {
  release: TemplateRelease & {
    sourceReleaseId: string;
    sourceReleaseGeneration: number;
    sourceReleaseHash: string;
    accountId: string;
    accountRevision: number;
    providerIdentityHash: string;
  };
  projection: NativeProjection;
}

export const changed = () =>
  new ConflictError(
    'The wallet projection, source release or provider account changed.',
    'WALLET_PROJECTION_CONFLICT',
  );
const missing = () =>
  new NotFoundError('Wallet projection candidate not found.', 'WALLET_PROJECTION_NOT_FOUND');

/** Keep the same KEK bindings through every asynchronous read and final SQL fence. */
export function pinProjectionContext(ctx: ServiceContext): ServiceContext {
  const pinned = snapshotWalletCredentialContext(ctx);
  return { ...pinned, env: Object.freeze(pinned.env) };
}
export async function captureProjectionProof(
  ctx: ServiceContext,
): Promise<WalletCredentialKeysetProof> {
  return Object.freeze({
    credentialKeysetCommitment: await requireCredentialRefKeyset(ctx.env.DB, ctx.env),
  });
}
export async function requireProjectionProof(
  ctx: ServiceContext,
  proof: WalletCredentialKeysetProof,
): Promise<void> {
  if (
    typeof proof?.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(proof.credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== proof.credentialKeysetCommitment
  )
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
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
  authority: TemplateAuthority,
): Promise<never> {
  await assertTemplateAuthority(ctx, authority);
  throw changed();
}
export function candidateDto(
  row: ProjectionCandidate,
  approvals: ApprovalRow[],
): TemplateCandidate {
  const { credentialKeysetCommitment: _credentialKeysetCommitment, ...candidate } = row;
  return { ...candidate, approvals: approvals.map((a) => ({ ...a })) };
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
  proof: WalletCredentialKeysetProof,
): Promise<boolean> {
  const policy = projectionPolicy(candidate.provider);
  if (
    candidate.credentialKeysetCommitment !== proof.credentialKeysetCommitment ||
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
      { accountId: candidate.accountId, accountRevision: candidate.accountRevision, ...proof },
    );
  } catch (error) {
    if (error instanceof UnavailableError) return false;
    throw error;
  }
  if (
    !account ||
    account.provider !== candidate.provider ||
    account.accountId !== candidate.accountId ||
    account.revision !== candidate.accountRevision ||
    account.credentialKeysetCommitment !== proof.credentialKeysetCommitment ||
    (await providerIdentityHash(account)) !== candidate.providerIdentityHash
  )
    return false;
  try {
    assertProjectionSource(candidate.projection, source.version);
  } catch (error) {
    if (error instanceof ConflictError) return false;
    throw error;
  }
  return true;
}
export async function scopedCandidate(
  ctx: ServiceContext,
  scope: ProjectionScope,
  id: string,
  hash: string,
  proof: WalletCredentialKeysetProof,
): Promise<ProjectionCandidate> {
  const candidate = await getProjectionCandidate(ctx.env.DB, id);
  if (!candidate || !sameScope(candidate, scope)) throw missing();
  if (candidate.candidateHash !== hash || !(await verifiedCandidate(ctx, candidate, proof)))
    throw changed();
  return candidate;
}
