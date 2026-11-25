import type { Grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import type { DenyReason } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import type { ApprovalRow } from '../templates/repo-releases.ts';
import { hasCredentialSql } from './account-presence.ts';
import { projectionPolicy } from './projection-contract.ts';
import {
  type ProjectionAuthority,
  versionAuthorIndependentSql,
} from './projection-system-authority.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { projectionGrant } from './repo-projection-grants.ts';
import type { ProjectionCandidate } from './repo-projection-store.ts';

/** A check over template and wallet tables compares tenant columns with the actor row `a`. */
export const check = (
  reason: DenyReason,
  sql: (bind: (v: string | number | null) => string) => string,
) => ({ reason, ok: (b) => sql((v) => b.bind(v)) }) satisfies Check;

/** The audit row that commits with a write, and only while the written row exists. */
export interface ProjectionAudit {
  action: string;
  detail: Record<string, unknown>;
}

/** SQL predicates refer only to immutable, trusted aliases chosen by these repository methods. */
export function currentSourceAndAccount(alias: string): string {
  return `EXISTS (SELECT 1 FROM template_provider_apple_sources source
      JOIN template_versions version ON version.template_id = source.template_id AND version.version = source.version
      JOIN wallet_provider_accounts account ON account.id = ${alias}.provider_account_id
        AND account.org_id = ${alias}.org_id AND account.mode = ${alias}.mode AND account.provider = ${alias}.provider
        AND account.authority_epoch = ${alias}.provider_account_epoch AND ${hasCredentialSql('account')}
        AND account.revoked_at IS NULL
      WHERE source.id = ${alias}.source_release_id AND source.template_id = ${alias}.template_id
        AND source.mode = ${alias}.mode AND source.version = ${alias}.version
        AND (source.org_id = ${alias}.org_id OR (source.org_id IS NULL AND source.origin = 'baked' AND source.template_org_id IS NULL))
        AND source.generation = ${alias}.source_release_generation AND source.candidate_hash = ${alias}.source_release_hash
        AND source.content_hash = ${alias}.content_hash AND version.created_by IS ${alias}.version_author_id)`;
}

const ENTITY = {
  candidate: 'template_candidates',
  approve: 'template_approvals',
  release: 'template_releases',
} as const;

/** Commits a grant that wrote one row of `entity` and its audit; false when the row did not land. */
export async function commitOne(
  ctx: ServiceContext,
  g: Grant,
  entity: keyof typeof ENTITY,
  entityId: string,
  authority: ProjectionAuthority,
  orgId: string,
  templateId: string,
  audit: ProjectionAudit,
  write: () => void,
): Promise<boolean> {
  write();
  g.add(
    grantedAudit(
      g,
      ctx,
      {
        orgId,
        actorType: authority.userId.startsWith('system:') ? 'system' : 'user',
        actorId: authority.userId,
        action: audit.action,
        targetType: 'template',
        targetId: templateId,
        detail: audit.detail,
      },
      [exists(ENTITY[entity], { id: entityId })],
    ),
  );
  const [inserted] = await g.commit();
  return (inserted?.results.length ?? 0) === 1;
}

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
  'source_release_id',
  'source_release_generation',
  'source_release_hash',
  'provider_account_id',
  'provider_account_revision',
  'provider_identity_hash',
  'projection_json',
  'credential_keyset_commitment',
  'provider_account_epoch',
];

/**
 * The org and mode come from the grant. The source, version and account must still be what the candidate
 * names: the account under the epoch it captured (a key rotation under the same identity does not move it).
 */
export async function writeProjectionCandidate(
  ctx: ServiceContext,
  c: ProjectionCandidate,
  authority: ProjectionAuthority,
  audit: ProjectionAudit,
): Promise<boolean> {
  const policy = projectionPolicy(c.provider);
  const onPolicy =
    c.adapterRevision === policy.adapterRevision &&
    c.audiencePolicyRevision === policy.audiencePolicyRevision &&
    JSON.stringify(c.adapterCapabilities) === JSON.stringify(policy.adapterCapabilities);
  const g = projectionGrant(ctx, authority, 'candidate', c.mode, c.id, [
    check(
      'config',
      (p) => `EXISTS (SELECT 1 FROM wallet_provider_accounts x
        WHERE x.id = ${p(c.accountId)} AND x.org_id = a.org_id AND x.mode = ${p(c.mode)} AND x.provider = ${p(c.provider)}
          AND x.authority_epoch = ${p(c.accountEpoch)} AND ${hasCredentialSql('x')} AND x.revoked_at IS NULL)`,
    ),
    check(
      'lineage',
      (p) => `EXISTS (SELECT 1 FROM template_provider_apple_sources source
        JOIN template_versions v ON v.template_id = source.template_id AND v.version = source.version
        WHERE source.id = ${p(c.sourceReleaseId)} AND source.template_id = ${p(c.templateId)}
          AND source.mode = ${p(c.mode)} AND source.version = ${p(c.version)} AND source.generation = ${p(c.sourceReleaseGeneration)}
          AND source.candidate_hash = ${p(c.sourceReleaseHash)} AND source.content_hash = ${p(c.contentHash)}
          AND (source.org_id = a.org_id OR (source.org_id IS NULL AND source.origin = 'baked' AND source.template_org_id IS NULL))
          AND v.created_by IS ${p(c.versionAuthorId)})`,
    ),
    check('config', (p) => `${p(c.credentialKeysetCommitment)} = ${pinnedKeysetSql}`),
    check(
      'lineage',
      (p) => `${p(onPolicy ? 1 : 0)} = 1 AND ${p(c.authorId)} = ${p(authority.userId)}`,
    ),
  ]);
  if (!g) return false;
  return commitOne(ctx, g, 'candidate', c.id, authority, c.orgId, c.templateId, audit, () =>
    g.insertSelect(
      'template_candidates',
      CANDIDATE_COLUMNS,
      [
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
        c.sourceReleaseId,
        c.sourceReleaseGeneration,
        c.sourceReleaseHash,
        c.accountId,
        c.accountRevision,
        c.providerIdentityHash,
        canonicalJson(c.projection),
        c.credentialKeysetCommitment,
        c.accountEpoch,
      ],
      { returning: ['id'] },
    ),
  );
}

/** The candidate as approved: hash, authors, policy, keyset, source and the account's epoch. */
const approvable = (c: ProjectionCandidate, reviewerId: string) => {
  const policy = projectionPolicy(c.provider);
  return check(
    'lineage',
    (p) => `EXISTS (SELECT 1 FROM template_candidates c
      WHERE c.id = ${p(c.id)} AND c.org_id = a.org_id AND c.mode = ${p(c.mode)} AND c.provider = ${p(c.provider)}
        AND c.candidate_hash = ${p(c.candidateHash)}
        AND c.author_id != ${p(reviewerId)} AND ${versionAuthorIndependentSql('c', p(reviewerId))}
        AND c.adapter_revision = ${p(policy.adapterRevision)}
        AND c.adapter_capabilities = ${p(JSON.stringify(policy.adapterCapabilities))}
        AND c.audience_policy_revision = ${p(policy.audiencePolicyRevision)}
        AND c.credential_keyset_commitment = ${pinnedKeysetSql}
        AND (${currentSourceAndAccount('c')}))`,
  );
};

export async function writeProjectionApproval(
  ctx: ServiceContext,
  a: ApprovalRow,
  c: ProjectionCandidate,
  authority: ProjectionAuthority,
  audit: ProjectionAudit,
): Promise<boolean> {
  const g = projectionGrant(ctx, authority, 'approve', c.mode, a.id, [approvable(c, a.reviewerId)]);
  if (!g || a.reviewerId !== authority.userId) return false;
  return commitOne(ctx, g, 'approve', a.id, authority, c.orgId, c.templateId, audit, () =>
    g.insertJoined('template_approvals', {
      parents: { candidate_id: c.id },
      columns: [
        'id',
        'candidate_hash',
        'reviewer_id',
        'created_at',
        'credential_keyset_commitment',
      ],
      values: [a.id, a.candidateHash, a.reviewerId, a.createdAt, c.credentialKeysetCommitment],
      returning: ['id'],
    }),
  );
}
