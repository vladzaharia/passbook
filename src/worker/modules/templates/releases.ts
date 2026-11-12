import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ApproveTemplateCandidate,
  PublishTemplateRelease,
  RollbackTemplateRelease,
  TemplateApproval,
  TemplateCandidateList,
  TemplateRelease,
  TemplateReleaseList,
  TemplateReleaseProvider,
  TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  activeProjectionRelease,
  approveProjectionCandidate,
  listProjectionCandidates,
  listProjectionReleases,
  publishProjectionRelease,
  rollbackProjectionRelease,
} from '../wallet-providers/projection-service.ts';
import { authorizeTemplateWrite } from './access.ts';
import { activeAppleRelease } from './releases-active.ts';
import { approvalMatches, scopedCandidate } from './releases-candidate.ts';
import { commitRelease } from './releases-commit.ts';
import {
  changed,
  missingRelease,
  noRelease,
  repositoryScope,
  scopedTemplate,
  toApproval,
  toCandidate,
  toRelease,
  writable,
} from './releases-domain.ts';
import { userNames } from './repo-release-names.ts';
import { writeApproval } from './repo-release-write.ts';
import {
  type ApprovalRow,
  getApproval,
  getLatestRelease,
  getRelease,
  listApprovals,
  listCandidates as selectCandidates,
  listReleases as selectReleases,
} from './repo-releases.ts';

export type { TemplateRelease } from '../../../shared/contracts/template-releases.ts';
export { createCandidate } from './releases-create.ts';

export async function listCandidates(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  scope: TemplateReleaseScope,
): Promise<TemplateCandidateList> {
  if (scope.provider !== 'apple') return listProjectionCandidates(ctx, auth, templateId, scope);
  await scopedTemplate(ctx, auth, templateId, scope);
  const rows = await selectCandidates(ctx.env.DB, repositoryScope(templateId, scope));
  const approvals = await Promise.all(rows.map((row) => listApprovals(ctx.env.DB, row.id)));
  const names = await userNames(ctx.env.DB, [
    ...rows.flatMap((row) => [row.authorId, row.versionAuthorId]),
    ...approvals.flatMap((list) => list.map((a) => a.reviewerId)),
  ]);
  return { items: rows.map((row, i) => toCandidate(row, approvals[i] ?? [], names)) };
}

export async function approveCandidate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  candidateId: string,
  body: ApproveTemplateCandidate,
): Promise<TemplateApproval> {
  if (body.provider !== 'apple')
    return approveProjectionCandidate(ctx, auth, templateId, candidateId, body);
  const template = await scopedTemplate(ctx, auth, templateId, body);
  writable(template, body);
  const authority = await authorizeTemplateWrite(ctx, auth, body.orgId, 'templates:review');
  const candidate = await scopedCandidate(ctx, templateId, candidateId, body, body.candidateHash);
  if (authority.userId === candidate.authorId || authority.userId === candidate.versionAuthorId)
    throw new ForbiddenError('The author cannot approve this candidate.', 'TEMPLATE_SELF_APPROVAL');
  const now = ctx.clock.now();
  const approval: ApprovalRow = {
    id: ctx.ids.id(),
    candidateId,
    candidateHash: candidate.candidateHash,
    reviewerId: authority.userId,
    createdAt: now,
  };
  const head = await getLatestRelease(ctx.env.DB, repositoryScope(templateId, body));
  await writeApproval(ctx, authority, approval, candidate, head?.id ?? null, {
    candidateId,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    mode: body.mode,
    provider: body.provider,
  });
  return toApproval(approval, await userNames(ctx.env.DB, [approval.reviewerId]));
}

/** The current generation, or null; the supplied org is the pass's actual organization. */
export async function activeRelease(
  ctx: ServiceContext,
  templateId: string,
  orgId: string,
  mode: Mode,
  provider: TemplateReleaseProvider,
): Promise<TemplateRelease | null> {
  if (provider !== 'apple') return activeProjectionRelease(ctx, templateId, orgId, mode, provider);
  return activeAppleRelease(ctx, templateId, orgId, mode, provider);
}

export async function requireApprovedRelease(
  ctx: ServiceContext,
  templateId: string,
  orgId: string,
  mode: Mode,
  provider: TemplateReleaseProvider,
): Promise<TemplateRelease> {
  return (
    (await activeRelease(ctx, templateId, orgId, mode, provider)) ??
    (() => {
      throw noRelease();
    })()
  );
}

export async function listReleases(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  scope: TemplateReleaseScope,
): Promise<TemplateReleaseList> {
  if (scope.provider !== 'apple') return listProjectionReleases(ctx, auth, templateId, scope);
  const template = await scopedTemplate(ctx, auth, templateId, scope);
  const effectiveOrg = template.origin === 'baked' && template.orgId === null ? null : scope.orgId;
  const rows = await selectReleases(ctx.env.DB, {
    ...repositoryScope(templateId, scope),
    orgId: effectiveOrg,
  });
  const active = await activeRelease(ctx, templateId, scope.orgId, scope.mode, scope.provider);
  const names = await userNames(ctx.env.DB, [
    ...rows.map((r) => r.createdBy),
    active?.createdBy ?? null,
  ]);
  return {
    active: active ? { ...active, createdByName: names.get(active.createdBy ?? '') ?? null } : null,
    items: rows.map((r) => toRelease(r, names)),
  };
}

export async function publishRelease(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  body: PublishTemplateRelease,
): Promise<TemplateRelease> {
  if (body.provider !== 'apple') return publishProjectionRelease(ctx, auth, templateId, body);
  const template = await scopedTemplate(ctx, auth, templateId, body);
  writable(template, body, body.mode === 'live' && template.orgId === body.orgId);
  const authority = await authorizeTemplateWrite(ctx, auth, body.orgId, 'templates:publish');
  const candidate = await scopedCandidate(
    ctx,
    templateId,
    body.candidateId,
    body,
    body.candidateHash,
  );
  const approval = await getApproval(ctx.env.DB, body.approvalId);
  if (!approval || !approvalMatches(approval, candidate)) throw changed();
  return commitRelease(
    ctx,
    authority,
    candidate,
    approval,
    body,
    body.expectedGeneration,
    'release',
    null,
    template.status === 'archived' ? 'archived' : 'active',
    null,
  );
}

export async function rollbackRelease(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  body: RollbackTemplateRelease,
): Promise<TemplateRelease> {
  if (body.provider !== 'apple') return rollbackProjectionRelease(ctx, auth, templateId, body);
  const template = await scopedTemplate(ctx, auth, templateId, body);
  writable(template, body, body.mode === 'live' && template.orgId === body.orgId);
  const authority = await authorizeTemplateWrite(ctx, auth, body.orgId, 'templates:publish');
  const target = await getRelease(ctx.env.DB, body.releaseId);
  if (
    !target ||
    target.templateId !== templateId ||
    target.orgId !== body.orgId ||
    target.mode !== body.mode ||
    target.provider !== body.provider
  )
    throw missingRelease();
  if (
    target.source !== 'approved' ||
    !target.candidateId ||
    !target.approvalId ||
    target.candidateHash !== body.candidateHash ||
    target.generation > body.expectedGeneration ||
    (target.generation === body.expectedGeneration && template.status !== 'archived')
  )
    throw changed();
  const candidate = await scopedCandidate(
    ctx,
    templateId,
    target.candidateId,
    body,
    body.candidateHash,
  );
  const approval = await getApproval(ctx.env.DB, target.approvalId);
  if (!approval || !approvalMatches(approval, candidate) || target.version !== candidate.version)
    throw changed();
  return commitRelease(
    ctx,
    authority,
    candidate,
    approval,
    body,
    body.expectedGeneration,
    'rollback',
    target.id,
    template.status === 'archived' ? 'archived' : 'active',
    body.reason,
  );
}
