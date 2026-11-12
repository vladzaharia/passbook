import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { ApprovalRow, CandidateRow } from '../templates/repo-releases.ts';
import type { WalletCredentialKeysetProof } from './instance-types.ts';
import {
  type NativeProjection,
  NativeProjectionSchema,
  type NativeProvider,
} from './projection-contract.ts';

export {
  insertProjectionApprovalStmt,
  insertProjectionCandidateStmt,
  insertProjectionReleaseStmt,
} from './repo-projection-write.ts';

export interface ProjectionCandidate
  extends Omit<CandidateRow, 'orgId' | 'provider'>,
    WalletCredentialKeysetProof {
  orgId: string;
  provider: NativeProvider;
  sourceReleaseId: string;
  sourceReleaseGeneration: number;
  sourceReleaseHash: string;
  accountId: string;
  accountRevision: number;
  providerIdentityHash: string;
  projection: NativeProjection;
}
export interface ProjectionScope {
  orgId: string;
  mode: Mode;
  provider: NativeProvider;
  templateId: string;
}
interface StoredCandidate extends Omit<ProjectionCandidate, 'projection' | 'adapterCapabilities'> {
  projectionJson: string;
  adapterCapabilities: string;
}
const candidateColumns = `id, template_id AS templateId, org_id AS orgId, mode, provider, version,
  candidate_hash AS candidateHash, content_hash AS contentHash, adapter_revision AS adapterRevision,
  adapter_capabilities AS adapterCapabilities, audience_policy_revision AS audiencePolicyRevision,
  author_id AS authorId, version_author_id AS versionAuthorId, created_at AS createdAt,
  source_release_id AS sourceReleaseId, source_release_generation AS sourceReleaseGeneration,
  source_release_hash AS sourceReleaseHash, provider_account_id AS accountId,
  provider_account_revision AS accountRevision, provider_identity_hash AS providerIdentityHash,
  projection_json AS projectionJson, credential_keyset_commitment AS credentialKeysetCommitment`;
function decode(row: StoredCandidate): ProjectionCandidate | null {
  try {
    const projection = NativeProjectionSchema.safeParse(JSON.parse(row.projectionJson));
    const capabilities: unknown = JSON.parse(row.adapterCapabilities);
    if (
      !projection.success ||
      projection.data.provider !== row.provider ||
      !Array.isArray(capabilities) ||
      !capabilities.every((value) => typeof value === 'string') ||
      typeof row.credentialKeysetCommitment !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.credentialKeysetCommitment)
    )
      return null;
    const { projectionJson: _projectionJson, ...rest } = row;
    return { ...rest, projection: projection.data, adapterCapabilities: capabilities as string[] };
  } catch {
    return null;
  }
}
export async function getProjectionCandidate(
  db: D1Database,
  id: string,
): Promise<ProjectionCandidate | null> {
  const row = await first<StoredCandidate>(
    db,
    `SELECT ${candidateColumns} FROM template_candidates WHERE id = ? AND provider IN ('google','samsung')`,
    [id],
  );
  return row ? decode(row) : null;
}
export async function selectProjectionCandidates(
  db: D1Database,
  scope: ProjectionScope,
  proof: WalletCredentialKeysetProof,
): Promise<ProjectionCandidate[]> {
  const rows = await all<StoredCandidate>(
    db,
    `SELECT ${candidateColumns} FROM template_candidates
    WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = ?
      AND credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
    ORDER BY created_at DESC, id DESC`,
    [
      scope.templateId,
      scope.orgId,
      scope.mode,
      scope.provider,
      proof.credentialKeysetCommitment,
      proof.credentialKeysetCommitment,
    ],
  );
  return rows.flatMap((row) => {
    const decoded = decode(row);
    return decoded ? [decoded] : [];
  });
}

/** Fetch only candidates referenced by releases in this exact provider scope, once per history read. */
export async function selectReleasedProjectionCandidates(
  db: D1Database,
  scope: ProjectionScope,
  proof: WalletCredentialKeysetProof,
): Promise<ProjectionCandidate[]> {
  const values = [scope.templateId, scope.orgId, scope.mode, scope.provider];
  const rows = await all<StoredCandidate>(
    db,
    `SELECT ${candidateColumns} FROM template_candidates
    WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = ? AND credential_keyset_commitment = ?
      AND id IN (SELECT candidate_id FROM template_releases
        WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = ? AND candidate_id IS NOT NULL
          AND credential_keyset_commitment = ?) AND ${credentialRefKeysetSql}`,
    [
      ...values,
      proof.credentialKeysetCommitment,
      ...values,
      proof.credentialKeysetCommitment,
      proof.credentialKeysetCommitment,
    ],
  );
  return rows.flatMap((row) => {
    const decoded = decode(row);
    return decoded ? [decoded] : [];
  });
}

/** Read all approvals for the scoped candidate list without a query per candidate. */
export async function selectProjectionApprovals(
  db: D1Database,
  scope: ProjectionScope,
  proof: WalletCredentialKeysetProof,
): Promise<ApprovalRow[]> {
  return all<ApprovalRow>(
    db,
    `SELECT a.id, a.candidate_id AS candidateId, a.candidate_hash AS candidateHash,
    a.reviewer_id AS reviewerId, a.created_at AS createdAt
    FROM template_approvals a JOIN template_candidates c ON c.id = a.candidate_id
    WHERE c.template_id = ? AND c.org_id = ? AND c.mode = ? AND c.provider = ?
      AND c.credential_keyset_commitment = ? AND a.credential_keyset_commitment = c.credential_keyset_commitment
      AND ${credentialRefKeysetSql}
    ORDER BY a.created_at DESC, a.id DESC`,
    [
      scope.templateId,
      scope.orgId,
      scope.mode,
      scope.provider,
      proof.credentialKeysetCommitment,
      proof.credentialKeysetCommitment,
    ],
  );
}

/** Only releases and reviews retaining the exact original keyset belong in native history. */
export async function selectProjectionReleaseIds(
  db: D1Database,
  scope: ProjectionScope,
  proof: WalletCredentialKeysetProof,
): Promise<Set<string>> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT r.id FROM template_releases r
    JOIN template_candidates c ON c.id = r.candidate_id
    JOIN template_approvals a ON a.id = r.approval_id AND a.candidate_id = c.id
    WHERE r.template_id = ? AND r.org_id = ? AND r.mode = ? AND r.provider = ?
      AND r.credential_keyset_commitment = ? AND c.credential_keyset_commitment = r.credential_keyset_commitment
      AND a.credential_keyset_commitment = r.credential_keyset_commitment AND ${credentialRefKeysetSql}`,
    [
      scope.templateId,
      scope.orgId,
      scope.mode,
      scope.provider,
      proof.credentialKeysetCommitment,
      proof.credentialKeysetCommitment,
    ],
  );
  return new Set(rows.map((row) => row.id));
}

/** Exact digest envelope. Approval covers the complete mapping, source and account identity. */
export function projectionCandidateEnvelope(c: ProjectionCandidate) {
  return {
    templateId: c.templateId,
    orgId: c.orgId,
    mode: c.mode,
    provider: c.provider,
    version: c.version,
    contentHash: c.contentHash,
    adapterRevision: c.adapterRevision,
    adapterCapabilities: c.adapterCapabilities,
    audiencePolicyRevision: c.audiencePolicyRevision,
    authorId: c.authorId,
    versionAuthorId: c.versionAuthorId,
    createdAt: c.createdAt,
    sourceReleaseId: c.sourceReleaseId,
    sourceReleaseGeneration: c.sourceReleaseGeneration,
    sourceReleaseHash: c.sourceReleaseHash,
    accountId: c.accountId,
    accountRevision: c.accountRevision,
    providerIdentityHash: c.providerIdentityHash,
    credentialKeysetCommitment: c.credentialKeysetCommitment,
    projection: c.projection,
  };
}
