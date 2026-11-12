import type {
  TemplateApproval,
  TemplateCandidate,
  TemplateRelease,
  TemplateReleaseProvider,
  TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import { type AuthContext, modeOf } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateRow } from './repo.ts';
import type { ApprovalRow, CandidateRow, ReleaseRow } from './repo-releases.ts';
import { loadTemplate } from './service.ts';

export const noRelease = () =>
  new ConflictError(
    'An approved active template release is required.',
    'TEMPLATE_RELEASE_REQUIRED',
  );
export const changed = () =>
  new ConflictError('The template release changed. Reload and retry.', 'TEMPLATE_RELEASE_CONFLICT');
export const missingRelease = () =>
  new NotFoundError('Template release not found.', 'TEMPLATE_RELEASE_NOT_FOUND');

export function supported(provider: TemplateReleaseProvider): void {
  if (provider !== 'apple')
    throw new ConflictError(
      'This wallet provider is not configured for template releases.',
      'TEMPLATE_PROVIDER_UNSUPPORTED',
    );
}

function checkScope(auth: AuthContext | undefined, scope: TemplateReleaseScope): void {
  supported(scope.provider);
  if (modeOf(auth) !== scope.mode)
    throw new ForbiddenError(
      'The requested mode does not match the current session.',
      'TEMPLATE_MODE_MISMATCH',
    );
}

export function repositoryScope(templateId: string, scope: TemplateReleaseScope) {
  return { templateId, orgId: scope.orgId, mode: scope.mode, provider: scope.provider };
}

export function sameScope(
  candidate: CandidateRow,
  templateId: string,
  scope: TemplateReleaseScope,
): boolean {
  return (
    candidate.templateId === templateId &&
    candidate.orgId === scope.orgId &&
    candidate.mode === scope.mode &&
    candidate.provider === scope.provider
  );
}

export type Names = ReadonlyMap<string, string>;
const nameOf = (names: Names | undefined, id: string | null) =>
  names === undefined ? undefined : id === null ? null : (names.get(id) ?? null);

export function toApproval(row: ApprovalRow, names?: Names): TemplateApproval {
  const reviewerName = nameOf(names, row.reviewerId);
  return {
    id: row.id,
    candidateId: row.candidateId,
    candidateHash: row.candidateHash,
    reviewerId: row.reviewerId,
    ...(reviewerName === undefined ? {} : { reviewerName }),
    createdAt: row.createdAt,
  };
}

export function toCandidate(
  row: CandidateRow,
  approvals: ApprovalRow[],
  names?: Names,
): TemplateCandidate {
  if (row.orgId === null)
    throw new Error('A human release candidate must belong to an organization.');
  const authorName = nameOf(names, row.authorId);
  const versionAuthorName = nameOf(names, row.versionAuthorId);
  return {
    ...row,
    orgId: row.orgId,
    ...(authorName === undefined ? {} : { authorName }),
    ...(versionAuthorName === undefined ? {} : { versionAuthorName }),
    approvals: approvals.map((a) => toApproval(a, names)),
  };
}

export function toRelease(row: ReleaseRow, names?: Names): TemplateRelease {
  const createdByName = nameOf(names, row.createdBy);
  return {
    ...(createdByName === undefined ? {} : { createdByName }),
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
  };
}

export async function scopedTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  scope: TemplateReleaseScope,
): Promise<TemplateRow> {
  checkScope(auth, scope);
  return loadTemplate(ctx, auth, templateId, scope.orgId);
}

export function writable(
  row: TemplateRow,
  scope: TemplateReleaseScope,
  allowArchived = false,
): void {
  if (row.origin !== 'uploaded')
    throw new ForbiddenError('Built-in templates are released by the system.', 'TEMPLATE_BAKED');
  if (row.orgId !== null && row.orgId !== scope.orgId)
    throw new ConflictError(
      'This template belongs to another organization.',
      'TEMPLATE_ORG_REQUIRED',
    );
  if (row.status !== 'active' && !(allowArchived && row.status === 'archived'))
    throw new ConflictError('Archived templates cannot be changed.', 'TEMPLATE_ARCHIVED');
}
