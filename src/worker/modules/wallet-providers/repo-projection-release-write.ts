import { releaseHead } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ApprovalRow } from '../templates/repo-releases.ts';
import { reviews } from '../templates/repo-sole-reviewer.ts';
import { projectionPolicy } from './projection-contract.ts';
import { approvalStandsSql, type ProjectionAuthority } from './projection-system-authority.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { projectionGrant } from './repo-projection-grants.ts';
import type { ProjectionCandidate } from './repo-projection-store.ts';
import {
  check,
  commitOne,
  currentSourceAndAccount,
  type ProjectionAudit,
} from './repo-projection-write.ts';

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
  'credential_keyset_commitment',
];

export async function writeProjectionRelease(
  ctx: ServiceContext,
  input: {
    id: string;
    candidate: ProjectionCandidate;
    approval: ApprovalRow;
    authority: ProjectionAuthority;
    expectedGeneration: number;
    expectedReleaseId: string | null;
    action: 'release' | 'rollback';
    targetReleaseId: string | null;
    now: number;
    audit: ProjectionAudit;
  },
): Promise<boolean> {
  const { candidate: c, approval: a, authority } = input;
  const policy = projectionPolicy(c.provider);
  const same = `r.template_id = c.template_id AND r.org_id = c.org_id AND r.mode = c.mode AND r.provider = c.provider`;
  const g = projectionGrant(ctx, authority, 'release', c.mode, input.id, [
    check(
      'lineage',
      (p) => `EXISTS (SELECT 1 FROM template_candidates c
        JOIN template_approvals ap ON ap.candidate_id = c.id AND ap.candidate_hash = c.candidate_hash
        WHERE c.id = ${p(c.id)} AND ap.id = ${p(a.id)} AND c.org_id = a.org_id AND c.mode = ${p(c.mode)}
          AND c.provider = ${p(c.provider)} AND c.candidate_hash = ${p(c.candidateHash)}
          AND c.credential_keyset_commitment = ${pinnedKeysetSql}
          AND ap.credential_keyset_commitment = c.credential_keyset_commitment
          AND ${approvalStandsSql('ap', 'c')}
          AND (${p(input.action)} != 'release' OR ap.kind != 'sole' OR NOT EXISTS (SELECT 1 FROM org_memberships m
            WHERE m.org_id = c.org_id AND m.created_at > ap.created_at AND ${reviews('m')}))
          AND c.adapter_revision = ${p(policy.adapterRevision)}
          AND c.adapter_capabilities = ${p(JSON.stringify(policy.adapterCapabilities))}
          AND c.audience_policy_revision = ${p(policy.audiencePolicyRevision)}
          AND json_extract(c.projection_json, '$.schema') = 2
          AND (${currentSourceAndAccount('c')})
          AND ((${p(input.action)} = 'release' AND ${p(input.targetReleaseId)} IS NULL
              AND NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.candidate_id = c.id))
            OR (${p(input.action)} = 'rollback' AND EXISTS (SELECT 1 FROM template_releases r
              WHERE r.id = ${p(input.targetReleaseId)} AND ${same} AND r.generation < ${p(input.expectedGeneration)}
                AND r.candidate_id = c.id AND r.approval_id = ap.id AND r.candidate_hash = c.candidate_hash
                AND r.credential_keyset_commitment = c.credential_keyset_commitment))))`,
    ),
    check(
      'release',
      (
        p,
      ) => `COALESCE((SELECT MAX(r.generation) FROM template_releases r WHERE r.template_id = ${p(c.templateId)}
        AND r.org_id = a.org_id AND r.mode = ${p(c.mode)} AND r.provider = ${p(c.provider)}), 0) = ${p(input.expectedGeneration)}`,
    ),
    input.expectedReleaseId === null
      ? check(
          'release',
          (
            p,
          ) => `NOT EXISTS (SELECT 1 FROM template_releases r WHERE r.template_id = ${p(c.templateId)}
            AND r.org_id = a.org_id AND r.mode = ${p(c.mode)} AND r.provider = ${p(c.provider)})`,
        )
      : releaseHead(c.templateId, c.mode, c.provider, input.expectedReleaseId, 'existing'),
  ]);
  if (!g) return false;
  return commitOne(ctx, g, 'release', input.id, authority, c.orgId, c.templateId, input.audit, () =>
    g.insertSelect(
      'template_releases',
      RELEASE_COLUMNS,
      [
        input.id,
        c.templateId,
        c.mode,
        c.provider,
        input.expectedGeneration + 1,
        c.version,
        c.candidateHash,
        c.contentHash,
        c.adapterRevision,
        JSON.stringify(c.adapterCapabilities),
        c.audiencePolicyRevision,
        'approved',
        input.action,
        c.id,
        a.id,
        input.expectedReleaseId,
        input.targetReleaseId,
        authority.userId,
        input.now,
        c.credentialKeysetCommitment,
      ],
      { returning: ['id'] },
    ),
  );
}
