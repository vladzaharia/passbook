import { statusLabel } from '../../../passkit/wallets/fidelity.ts';
import type {
  ApproveTemplateCandidate,
  CreateTemplateCandidate,
  TemplateApproval,
  TemplateCandidate,
  TemplateCandidateList,
  TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { batch } from '../../platform/db.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeTemplateWrite } from '../templates/access.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { candidateHash } from '../templates/release-content.ts';
import type { VersionRow } from '../templates/repo.ts';
import { releaseAuditStmt } from '../templates/repo-release-audit.ts';
import type { ApprovalRow } from '../templates/repo-releases.ts';
import {
  getWalletProviderReadiness,
  readConfiguredWalletProviderCredentials,
} from './account-service.ts';
import {
  type NativeProjection,
  type ProjectionV2,
  type ProjectionV2Request,
  parseProjectionInput,
  projectionPolicy,
  providerIdentityHash,
} from './projection-contract.ts';
import { computeProjectionPins, samePins, unreleasable } from './projection-pins.ts';
import {
  candidateDto,
  captureProjectionProof,
  changed,
  failedWrite,
  nativeScope,
  pinProjectionContext,
  requireProjectionProof,
  scopedCandidate,
  scopedTemplate,
} from './projection-service-support.ts';
import { assertProjectionSource, verifiedAppleSource } from './projection-source.ts';
import {
  insertProjectionApprovalStmt,
  insertProjectionCandidateStmt,
  type ProjectionCandidate,
  projectionCandidateEnvelope,
  selectProjectionApprovals,
  selectProjectionCandidates,
} from './repo-projection-store.ts';

export {
  activeProjectionRelease,
  getApprovedProjection,
  listProjectionReleases,
} from './projection-read-service.ts';
export {
  publishProjectionRelease,
  rollbackProjectionRelease,
} from './projection-release-service.ts';
export type { ApprovedProjection } from './projection-service-support.ts';

export async function listProjectionCandidates(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  scope: TemplateReleaseScope,
): Promise<TemplateCandidateList> {
  ctx = pinProjectionContext(ctx);
  await scopedTemplate(ctx, auth, templateId, scope);
  const proof = await captureProjectionProof(ctx);
  const native = nativeScope(templateId, scope);
  const [candidates, approvals] = await Promise.all([
    selectProjectionCandidates(ctx.env.DB, native, proof),
    selectProjectionApprovals(ctx.env.DB, native, proof),
  ]);
  const approvalsByCandidate = new Map<string, ApprovalRow[]>();
  for (const approval of approvals) {
    const group = approvalsByCandidate.get(approval.candidateId);
    if (group) group.push(approval);
    else approvalsByCandidate.set(approval.candidateId, [approval]);
  }
  const items = candidates.map((candidate) =>
    candidateDto(candidate, approvalsByCandidate.get(candidate.id) ?? []),
  );
  await requireProjectionProof(ctx, proof);
  return { items };
}

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

export async function createProjectionCandidate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  body: CreateTemplateCandidate,
): Promise<TemplateCandidate> {
  ctx = pinProjectionContext(ctx);
  await scopedTemplate(ctx, auth, templateId, body);
  const scope = nativeScope(templateId, body);
  const authority = await authorizeTemplateWrite(ctx, auth, scope.orgId, 'templates:author');
  const proof = await captureProjectionProof(ctx);
  if (!body.sourceReleaseId || !body.version) throw new ValidationError();
  const named = parseProjectionInput(body.projection);
  if (named.provider !== scope.provider) throw new ValidationError();
  const source = await verifiedAppleSource(ctx, {
    ...scope,
    sourceReleaseId: body.sourceReleaseId,
    version: body.version,
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
    ...proof,
  });
  if (
    !account ||
    account.provider !== scope.provider ||
    account.credentialKeysetCommitment !== proof.credentialKeysetCommitment
  )
    throw changed();
  const policy = projectionPolicy(scope.provider);
  const candidate: ProjectionCandidate = {
    ...scope,
    ...proof,
    id: ctx.ids.id(),
    version: body.version,
    contentHash: source.release.contentHash,
    candidateHash: '',
    adapterRevision: policy.adapterRevision,
    adapterCapabilities: [...policy.adapterCapabilities],
    audiencePolicyRevision: policy.audiencePolicyRevision,
    authorId: authority.userId,
    versionAuthorId: source.version.createdBy,
    createdAt: ctx.clock.now(),
    sourceReleaseId: source.release.id,
    sourceReleaseGeneration: source.release.generation,
    sourceReleaseHash: source.release.candidateHash,
    accountId: account.accountId,
    accountRevision: account.revision,
    providerIdentityHash: await providerIdentityHash(account),
    projection,
  };
  candidate.candidateHash = await candidateHash(projectionCandidateEnvelope(candidate));
  const db = ctx.env.DB;
  const results = await batch(db, [
    insertProjectionCandidateStmt(db, candidate, authority, ctx.clock.now(), proof),
    releaseAuditStmt(
      db,
      ctx,
      'candidate',
      candidate.id,
      scope.orgId,
      authority.userId,
      templateId,
      'template.candidate',
      {
        candidateId: candidate.id,
        version: candidate.version,
        mode: scope.mode,
        provider: scope.provider,
        candidateHash: candidate.candidateHash,
      },
    ),
  ]);
  if (!results[0]?.meta.changes) return failedWrite(ctx, authority);
  return candidateDto(candidate, []);
}

export async function approveProjectionCandidate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  candidateId: string,
  body: ApproveTemplateCandidate,
): Promise<TemplateApproval> {
  ctx = pinProjectionContext(ctx);
  await scopedTemplate(ctx, auth, templateId, body);
  const scope = nativeScope(templateId, body);
  const authority = await authorizeTemplateWrite(ctx, auth, scope.orgId, 'templates:review');
  const proof = await captureProjectionProof(ctx);
  const candidate = await scopedCandidate(ctx, scope, candidateId, body.candidateHash, proof);
  if (authority.userId === candidate.authorId || authority.userId === candidate.versionAuthorId)
    throw new ForbiddenError('The author cannot approve this candidate.', 'TEMPLATE_SELF_APPROVAL');
  const approval: ApprovalRow = {
    id: ctx.ids.id(),
    candidateId,
    candidateHash: candidate.candidateHash,
    reviewerId: authority.userId,
    createdAt: ctx.clock.now(),
  };
  const db = ctx.env.DB;
  const results = await batch(db, [
    insertProjectionApprovalStmt(db, approval, candidate, authority, ctx.clock.now(), proof),
    releaseAuditStmt(
      db,
      ctx,
      'approval',
      approval.id,
      scope.orgId,
      authority.userId,
      templateId,
      'template.approve',
      {
        candidateId,
        approvalId: approval.id,
        candidateHash: candidate.candidateHash,
        mode: scope.mode,
        provider: scope.provider,
      },
    ),
  ]);
  if (!results[0]?.meta.changes) return failedWrite(ctx, authority);
  return approval;
}
