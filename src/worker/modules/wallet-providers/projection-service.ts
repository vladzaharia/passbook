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
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeTemplateWrite } from '../templates/access.ts';
import { releaseAuditStmt } from '../templates/repo-release-audit.ts';
import type { ApprovalRow } from '../templates/repo-releases.ts';
import { buildProjectionCandidate } from './projection-candidate-build.ts';
import {
  candidateDto,
  captureProjectionProof,
  failedWrite,
  nativeScope,
  pinProjectionContext,
  requireProjectionProof,
  scopedCandidate,
  scopedTemplate,
} from './projection-service-support.ts';
import { isSystemAuthored } from './projection-system-authority.ts';
import {
  insertProjectionApprovalStmt,
  insertProjectionCandidateStmt,
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
  const candidate = await buildProjectionCandidate(
    ctx,
    scope,
    {
      sourceReleaseId: body.sourceReleaseId,
      version: body.version,
      projection: body.projection,
      authorId: authority.userId,
    },
    proof,
  );
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
  if (
    authority.userId === candidate.authorId ||
    (authority.userId === candidate.versionAuthorId && !isSystemAuthored(candidate))
  )
    throw new ForbiddenError('The author cannot approve this candidate.', 'TEMPLATE_SELF_APPROVAL');
  const approval: ApprovalRow = {
    id: ctx.ids.id(),
    candidateId,
    candidateHash: candidate.candidateHash,
    reviewerId: authority.userId,
    kind: 'peer',
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
