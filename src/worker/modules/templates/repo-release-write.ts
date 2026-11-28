import type { PassStyle } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant } from '../../platform/authority.ts';
import { releaseHead } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { writePart } from '../../platform/authority-include.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import {
  RACE_TEMPLATE_APPROVAL_INSERT,
  RACE_TEMPLATE_CANDIDATE_INSERT,
  RACE_TEMPLATE_RELEASE_INSERT,
} from '../scan/race-tags.ts';
import type { TemplateAuthority } from './access.ts';
import {
  approvable,
  candidateTemplate,
  headGeneration,
  keyChecks,
  publishable,
} from './repo-grant-checks.ts';
import { templateGrant } from './repo-grants.ts';
import {
  CANDIDATE_COLUMNS,
  candidateValues,
  RELEASE_COLUMNS,
  releaseValues,
} from './repo-release-columns.ts';
import { invalidateEventCache } from './repo-release-effects.ts';
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

const returningId = (tag: string) => ({ returning: ['id'], tag });

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
      actorType: authority.kind === 'api_key' ? 'api_key' : 'user',
      actorId: authority.kind === 'api_key' ? authority.keyId : authority.userId,
      action,
      targetType: 'template',
      targetId: templateId,
      detail:
        authority.kind === 'api_key'
          ? { ...detail, actingUserId: authority.userId, membershipId: authority.membershipId }
          : detail,
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
    checks: [
      candidateTemplate(c.templateId, c.version, c.versionAuthorId),
      ...keyChecks(authority.kind, authority.kind === 'api_key' && authority.mode === 'live'),
    ],
  });
  g.insertSelect(
    'template_candidates',
    CANDIDATE_COLUMNS,
    candidateValues(c),
    returningId(RACE_TEMPLATE_CANDIDATE_INSERT),
  );
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
  g.include(writePart(`${h.sql} AND {grant}`, h.params));
  const [inserted] = await g.commit();
  if (!wrote(inserted)) throw releaseChanged();
}

/** Records a reviewer's approval: independent of the authors unless it is an audited sole or Test one. */
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
        authority.kind === 'platform' ? '' : authority.membershipId,
        a.kind,
        authority.kind === 'api_key',
      ),
      ...keyChecks(authority.kind),
      ...(headId === null
        ? []
        : [releaseHead(candidate.templateId, candidate.mode, candidate.provider, headId)]),
    ],
  });
  g.insertJoined('template_approvals', {
    parents: { candidate_id: a.candidateId },
    columns: ['id', 'candidate_hash', 'reviewer_id', 'kind', 'created_at'],
    values: [a.id, a.candidateHash, a.reviewerId, a.kind, a.createdAt],
    returning: ['id'],
    tag: RACE_TEMPLATE_APPROVAL_INSERT,
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
      a.kind === 'peer' ? 'template.approve' : 'template.approved_alone',
      { ...detail, kind: a.kind },
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
  const g = templateGrant(ctx, authority, 'release', {
    target: input.id,
    codes: CODES,
    checks: [
      ...keyChecks(authority.kind),
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
      // An archived template is restored by a rollback: its head counts under the existing-use rule.
      ...(input.expectedReleaseId === null
        ? []
        : [
            releaseHead(
              c.templateId,
              mode,
              c.provider,
              input.expectedReleaseId,
              input.expectedStatus === 'archived' ? 'existing' : 'issue',
            ),
          ]),
    ],
  });
  g.insertSelect(
    'template_releases',
    RELEASE_COLUMNS,
    releaseValues(input),
    returningId(RACE_TEMPLATE_RELEASE_INSERT),
  );
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
  invalidateEventCache(g, c.templateId, mode, c.orgId);
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
