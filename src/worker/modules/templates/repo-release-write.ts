import type { PassStyle } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant } from '../../platform/authority.ts';
import { releaseHead } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import type { SqlValue } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TemplateAuthority } from './access.ts';
import { APPLE_ADAPTER_CAPABILITIES } from './release-content.ts';
import { approvable, candidateTemplate, headGeneration, publishable } from './repo-grant-checks.ts';
import { grantRow, inGrant, templateGrant } from './repo-grants.ts';
import { eventIdsForRelease, invalidateEventCache } from './repo-release-effects.ts';
import type { ApprovalRow, CandidateRow } from './repo-releases.ts';
import { type VersionHashes, versionHashesSql } from './repo-version-hashes.ts';

export interface ActivateReleaseArgs {
  id: string;
  candidate: CandidateRow;
  approvalId: string;
  expectedGeneration: number;
  expectedReleaseId: string | null;
  targetReleaseId: string | null;
  action: 'release' | 'rollback';
  expectedStatus: 'active' | 'archived';
  createdBy: string;
  createdAt: number;
  /** Written to the template when the release becomes the live head of an org-owned template. */
  metadata: { name: string; description: string | null; styles: PassStyle[] } | null;
}

const capabilities = JSON.stringify(APPLE_ADAPTER_CAPABILITIES);

const RETURN_ID = { returning: ['id'] };

// The grant supplies org_id; the mode is the caller's (an org grant does not own it).
const CANDIDATE_COLUMNS = [
  'id',
  'template_id',
  'mode',
  'provider',
  'version',
  'candidate_hash',
  'content_hash',
  'adapter_revision',
  'adapter_capabilities',
  'audience_policy_revision',
  'author_id',
  'version_author_id',
  'created_at',
];
const RELEASE_COLUMNS = [
  'id',
  'template_id',
  'mode',
  'provider',
  'generation',
  'version',
  'candidate_hash',
  'content_hash',
  'adapter_revision',
  'adapter_capabilities',
  'audience_policy_revision',
  'source',
  'action',
  'candidate_id',
  'approval_id',
  'previous_release_id',
  'rollback_of_release_id',
  'created_by',
  'created_at',
];

function candidateValues(c: CandidateRow): SqlValue[] {
  return [
    c.id,
    c.templateId,
    c.mode,
    c.provider,
    c.version,
    c.candidateHash,
    c.contentHash,
    c.adapterRevision,
    JSON.stringify(c.adapterCapabilities),
    c.audiencePolicyRevision,
    c.authorId,
    c.versionAuthorId,
    c.createdAt,
  ];
}

function releaseValues(input: ActivateReleaseArgs): SqlValue[] {
  const c = input.candidate;
  return [
    input.id,
    c.templateId,
    c.mode,
    c.provider,
    input.expectedGeneration + 1,
    c.version,
    c.candidateHash,
    c.contentHash,
    c.adapterRevision,
    capabilities,
    c.audiencePolicyRevision,
    'approved',
    input.action,
    c.id,
    input.approvalId,
    input.expectedReleaseId,
    input.targetReleaseId,
    input.createdBy,
    input.createdAt,
  ];
}

/** A refused release write is a concurrent change: the same 409 the service has always raised. */
const CODES = {
  lineage: 'TEMPLATE_RELEASE_CONFLICT',
  stale: 'TEMPLATE_RELEASE_CONFLICT',
  config: 'TEMPLATE_RELEASE_CONFLICT',
  release: 'TEMPLATE_RELEASE_CONFLICT',
};

export const releaseChanged = () =>
  new ConflictError('The template release changed. Reload and retry.', 'TEMPLATE_RELEASE_CONFLICT');

const wrote = (result: { results: unknown[] } | undefined) => (result?.results.length ?? 0) === 1;

function audit(
  g: Grant,
  ctx: ServiceContext,
  authority: TemplateAuthority,
  table: 'template_candidates' | 'template_approvals' | 'template_releases',
  entityId: string,
  orgId: string,
  templateId: string,
  action: string,
  detail: Record<string, unknown>,
) {
  return grantedAudit(
    g,
    ctx,
    {
      orgId,
      actorType: 'user',
      actorId: authority.userId,
      action,
      targetType: 'template',
      targetId: templateId,
      detail,
    },
    [exists(table, { id: entityId })],
  );
}

/** Creates a candidate and its version hashes: the author must hold `templates:author`. */
export async function writeCandidate(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  c: CandidateRow,
  hashes: VersionHashes,
  detail: Record<string, unknown>,
): Promise<void> {
  const g = templateGrant(ctx, authority, 'candidate', {
    target: c.id,
    codes: CODES,
    checks: [candidateTemplate(c.templateId, c.version, c.versionAuthorId)],
  });
  g.insertSelect('template_candidates', CANDIDATE_COLUMNS, candidateValues(c), RETURN_ID);
  g.add(
    audit(
      g,
      ctx,
      authority,
      'template_candidates',
      c.id,
      c.orgId ?? '',
      c.templateId,
      'template.candidate',
      detail,
    ),
  );
  const h = versionHashesSql(c.templateId, c.version, hashes, c.createdAt, c.id);
  g.add(inGrant(g, `${h.sql} AND ${grantRow(g).sql}`, [...h.params, g.id]));
  const [inserted] = await g.commit();
  if (!wrote(inserted)) throw releaseChanged();
}

/** Records a reviewer's approval; the reviewer must differ from the candidate and version authors. */
export async function writeApproval(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  a: ApprovalRow,
  candidate: CandidateRow,
  headId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  const g = templateGrant(ctx, authority, 'approve', {
    target: a.id,
    codes: CODES,
    checks: [
      approvable(
        a.candidateId,
        a.candidateHash,
        a.reviewerId,
        authority.kind === 'session' ? authority.membershipId : '',
      ),
      ...(headId === null
        ? []
        : [releaseHead(candidate.templateId, candidate.mode, candidate.provider, headId)]),
    ],
  });
  g.insertJoined('template_approvals', {
    parents: { candidate_id: a.candidateId },
    columns: ['id', 'candidate_hash', 'reviewer_id', 'created_at'],
    values: [a.id, a.candidateHash, a.reviewerId, a.createdAt],
    returning: ['id'],
  });
  g.add(
    audit(
      g,
      ctx,
      authority,
      'template_approvals',
      a.id,
      candidate.orgId ?? '',
      candidate.templateId,
      'template.approve',
      detail,
    ),
  );
  const [inserted] = await g.commit();
  if (!wrote(inserted)) throw releaseChanged();
}

/**
 * Appends a generation only while the reviewed candidate, its independent approval, the template state
 * and the scope's head are what the caller read: a stale head or any changed row refuses the whole
 * batch (409). The template's active pointer, the event caches and the audit row commit with it.
 */
export async function writeRelease(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  input: ActivateReleaseArgs,
  auditDetail: Record<string, unknown>,
): Promise<void> {
  const c = input.candidate;
  const mode: Mode = c.mode;
  const eventIds = await eventIdsForRelease(ctx.env.DB, c.templateId, mode, c.orgId);
  const g = templateGrant(ctx, authority, 'release', {
    target: input.id,
    codes: CODES,
    checks: [
      publishable({
        candidateId: c.id,
        approvalId: input.approvalId,
        candidateHash: c.candidateHash,
        expectedStatus: input.expectedStatus,
        headId: input.expectedReleaseId,
        action: input.action,
        targetReleaseId: input.targetReleaseId,
        expectedGeneration: input.expectedGeneration,
      }),
      headGeneration(c.templateId, mode, c.provider, input.expectedGeneration),
      // releaseHead requires an active template; an archived one is restored by a rollback, and the
      // generation check above already pins its head.
      ...(input.expectedReleaseId === null || input.expectedStatus === 'archived'
        ? []
        : [releaseHead(c.templateId, mode, c.provider, input.expectedReleaseId)]),
    ],
  });
  g.insertSelect('template_releases', RELEASE_COLUMNS, releaseValues(input), RETURN_ID);
  if (input.metadata)
    g.update('templates', {
      set: {
        active_version: c.version,
        name: input.metadata.name,
        description: input.metadata.description,
        styles: JSON.stringify(input.metadata.styles),
        status: 'active',
        updated_at: maxNow(input.createdAt),
      },
      where: { id: c.templateId },
      require: 'one',
      returning: ['id'],
    });
  invalidateEventCache(g, eventIds, mode);
  g.add(
    audit(
      g,
      ctx,
      authority,
      'template_releases',
      input.id,
      c.orgId ?? '',
      c.templateId,
      input.action === 'release' ? 'template.release' : 'template.rollback',
      auditDetail,
    ),
  );
  const [inserted] = await g.commit();
  if (!wrote(inserted)) throw releaseChanged();
}
