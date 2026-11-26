import type {
  ApproveTemplateCandidate,
  CreateTemplateCandidate,
  TemplateApproval,
  TemplateCandidate,
  TemplateCandidateList,
  TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { FeatureNotIncludedError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { authorizeTemplateWrite, holdsTemplateCapability } from '../templates/access.ts';
import type { ApprovalRow } from '../templates/repo-releases.ts';
import { approvalKind, soleAuditDetail } from '../templates/sole-reviewer.ts';
import { walletAvailability } from './enrolment-read.ts';
import { buildProjectionCandidate } from './projection-candidate-build.ts';
import { currentReview } from './projection-review-current.ts';
import {
  candidateDto,
  failedWrite,
  nativeScope,
  pinProjectionContext,
  scopedCandidate,
  scopedTemplate,
} from './projection-service-support.ts';
import { isSelfAuthored } from './projection-system-authority.ts';
import { walletEntitled } from './repo-enrolment-gate.ts';
import { selectProjectionApprovals, selectProjectionCandidates } from './repo-projection-store.ts';
import { writeProjectionApproval, writeProjectionCandidate } from './repo-projection-write.ts';

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
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const native = nativeScope(templateId, scope);
  const [candidates, approvals, current] = await Promise.all([
    selectProjectionCandidates(ctx.env.DB, native),
    selectProjectionApprovals(ctx.env.DB, native),
    currentReview(ctx, native),
  ]);
  const approvalsByCandidate = new Map<string, ApprovalRow[]>();
  for (const approval of approvals) {
    const group = approvalsByCandidate.get(approval.candidateId);
    if (group) group.push(approval);
    else approvalsByCandidate.set(approval.candidateId, [approval]);
  }
  const viewer = auth?.kind === 'session' ? auth.userId : undefined;
  const items = candidates.map((candidate) =>
    candidateDto(candidate, approvalsByCandidate.get(candidate.id) ?? [], viewer),
  );
  const wallet = (await holdsTemplateCapability(ctx, auth, scope.orgId, 'templates:review'))
    ? await walletAvailability(ctx, scope.orgId, scope.mode, native.provider)
    : undefined;
  return {
    items,
    nextCursor: null,
    ...(current ? { current } : {}),
    ...(wallet ? { wallet } : {}),
  };
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
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  if (!body.sourceReleaseId || !body.version) throw new ValidationError();
  // The plan before the account: a plan without the wallet is a 403, not a "changed, retry" conflict.
  const feature = `wallet.${scope.provider}` as const;
  if (!(await walletEntitled(ctx.env.DB, scope.provider, scope.orgId)))
    throw new FeatureNotIncludedError(feature, featureNotIncluded(feature));
  const candidate = await buildProjectionCandidate(
    ctx,
    scope,
    {
      sourceReleaseId: body.sourceReleaseId,
      version: body.version,
      projection: body.projection,
      authorId: authority.userId,
    },
    credentialKeysetCommitment,
  );
  const written = await writeProjectionCandidate(ctx, candidate, authority, {
    action: 'template.candidate',
    detail: {
      candidateId: candidate.id,
      version: candidate.version,
      mode: scope.mode,
      provider: scope.provider,
      candidateHash: candidate.candidateHash,
    },
  });
  if (!written) return failedWrite(ctx, authority);
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
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const candidate = await scopedCandidate(ctx, scope, candidateId, body.candidateHash);
  // The version author is a genuine second party to a system candidate (its author is the platform), so their
  // approval is `peer`, as for Google: only a person's own candidate or version counts as self-authored.
  const kind = await approvalKind(ctx, {
    orgId: scope.orgId,
    mode: scope.mode,
    provider: scope.provider,
    selfAuthored: isSelfAuthored(authority.userId, candidate),
    alone: body.alone,
  });
  const approval: ApprovalRow = {
    id: ctx.ids.id(),
    candidateId,
    candidateHash: candidate.candidateHash,
    reviewerId: authority.userId,
    kind,
    createdAt: ctx.clock.now(),
  };
  const written = await writeProjectionApproval(ctx, approval, candidate, authority, {
    action: 'template.approve',
    detail: {
      candidateId,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      mode: scope.mode,
      provider: scope.provider,
      ...(await soleAuditDetail(ctx, scope.orgId, kind)),
    },
  });
  if (!written) return failedWrite(ctx, authority);
  return approval;
}
