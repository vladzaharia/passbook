import type { SqlValue } from '../../platform/db.ts';
import { stmt } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import { issuedReleasePredicateSql, noScopedReleaseSql } from '../templates/repo-releases.ts';
import { decodeBoundLiveTemplateSnapshot } from './live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import { scanConjunction } from './repo-secret-binds.ts';
import { readCandidateTemplateSnapshot } from './template-read-snapshot.ts';

/** Server-only, original D1 projection. Never serialize this into an API response or grant. */
export interface LiveTemplateSnapshot {
  raw: string;
}

/** Read-only policy inspection may see an incompatible head; disclosure/commit may not. */
export type LiveTemplateSnapshotPurpose = 'read' | 'commit';

export interface LiveTemplateSnapshotRow {
  live_template_snapshot: string | null;
}

/** The pass and release fields from the *same* SELECT as the snapshot. */
export interface LiveTemplateBinding {
  pass: {
    id: string;
    orgId: string;
    mode: 'live' | 'test';
    templateId: string;
    templateVersion: string;
    releaseId: string | null;
  };
  activeReleaseId: string | null;
  activeReleaseGeneration: number | null;
  activeReleaseVersion: string | null;
  activeReleaseCandidateHash: string | null;
  activeTemplateVersion: string | null;
  displayTemplateVersion: string | null;
}

const scope = {
  templateIdSql: 'p.template_id',
  orgIdSql: 'p.org_id',
  modeSql: 'p.mode',
  providerSql: "'apple'",
};

// The names and key order of these JSON projections are shared with the final CAS below.
// Manifest, pass.json, assets and report remain raw text, including their original bytes.
function versionSql(alias: string): string {
  return `CASE WHEN ${alias}.version IS NULL THEN NULL ELSE json_object(
    'version', ${alias}.version, 'buildKey', ${alias}.build_key,
    'manifest', ${alias}.manifest, 'passJson', ${alias}.pass_json,
    'assets', ${alias}.assets, 'report', ${alias}.report,
    'createdBy', ${alias}.created_by, 'createdAt', ${alias}.created_at,
    'extrasSeal', (SELECT extras_hash FROM template_version_extra_sets s
      WHERE s.template_id=${alias}.template_id AND s.version=${alias}.version),
    'extras', json((SELECT json_group_array(json_object('name', e.name, 'size', e.size,
      'sha1', e.sha1, 'sha256', e.sha256, 'r2Key', e.r2_key)) FROM (
        SELECT name, size, sha1, sha256, r2_key FROM template_version_extras
        WHERE template_id=${alias}.template_id AND version=${alias}.version ORDER BY name
      ) e))
  ) END`;
}

function releaseSql(alias: string): string {
  return `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_object(
    'id', ${alias}.id, 'generation', ${alias}.generation, 'templateId', ${alias}.template_id,
    'orgId', ${alias}.org_id, 'mode', ${alias}.mode, 'provider', ${alias}.provider,
    'version', ${alias}.version, 'candidateHash', ${alias}.candidate_hash,
    'contentHash', ${alias}.content_hash, 'adapterRevision', ${alias}.adapter_revision,
    'adapterCapabilities', ${alias}.adapter_capabilities,
    'audiencePolicyRevision', ${alias}.audience_policy_revision,
    'source', ${alias}.source, 'action', ${alias}.action,
    'candidateId', ${alias}.candidate_id, 'approvalId', ${alias}.approval_id,
    'createdAt', ${alias}.created_at,
    'candidate', json((SELECT json_object('id', c.id, 'templateId', c.template_id,
      'orgId', c.org_id, 'mode', c.mode, 'provider', c.provider, 'version', c.version,
      'candidateHash', c.candidate_hash, 'contentHash', c.content_hash,
      'adapterRevision', c.adapter_revision, 'adapterCapabilities', c.adapter_capabilities,
      'audiencePolicyRevision', c.audience_policy_revision, 'authorId', c.author_id,
      'versionAuthorId', c.version_author_id, 'createdAt', c.created_at)
      FROM template_candidates c WHERE c.id=${alias}.candidate_id)),
    'approval', json((SELECT json_object('id', a.id, 'candidateId', a.candidate_id,
      'candidateHash', a.candidate_hash, 'reviewerId', a.reviewer_id)
      FROM template_approvals a WHERE a.id=${alias}.approval_id))
  ) END`;
}

/**
 * Append to the Candidate SELECT, which must use the following joins in the same statement:
 *   LEFT JOIN templates snapshot_template ON snapshot_template.id=p.template_id
 *   LEFT JOIN template_versions snapshot_active ON snapshot_active.template_id=p.template_id
 *     AND snapshot_active.version=COALESCE(ar.version,legacy.version)
 * Existing aliases p, pinned, ar and legacy are the candidate's pass, immutable pinned row,
 * effective scoped Apple release and no-history legacy row. Do not replace this with a later read.
 */
export function liveTemplateSnapshotColumnsSql(): string {
  return `${snapshotExpressionSql()} AS live_template_snapshot`;
}

function snapshotExpressionSql(): string {
  return `json_object(
    'passId', p.id, 'orgId', p.org_id, 'mode', p.mode, 'templateId', p.template_id,
    'pinnedVersion', p.template_version, 'issuedId', p.release_id,
    'owner', json_object('id', snapshot_template.id, 'orgId', snapshot_template.org_id,
      'origin', snapshot_template.origin, 'status', snapshot_template.status),
    'pinned', json(${versionSql('pinned')}),
    'active', json(${versionSql('snapshot_active')}),
    'release', json(${releaseSql('ar')}),
    'issued', json((SELECT ${releaseSql('issued')} FROM template_releases issued
      WHERE issued.id=p.release_id)),
    'noHistory', CASE WHEN (${noScopedReleaseSql(scope)}) THEN 1 ELSE 0 END
  )`;
}

const snapshotJoins = `LEFT JOIN templates snapshot_template ON snapshot_template.id=p.template_id
  LEFT JOIN template_versions pinned ON pinned.template_id=p.template_id AND pinned.version=p.template_version
  LEFT JOIN template_releases ar ON ar.id=(${effectiveReleaseIdSql(scope)})
  LEFT JOIN template_versions legacy ON legacy.template_id=p.template_id AND legacy.version=p.template_version
    AND p.release_id IS NULL AND ar.id IS NULL AND (${noScopedReleaseSql(scope)})
  LEFT JOIN template_versions snapshot_active ON snapshot_active.template_id=p.template_id
    AND snapshot_active.version=COALESCE(ar.version,legacy.version)`;

const issuedPredicate = issuedReleasePredicateSql(
  { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
  scope,
);

/**
 * The joined singleton filters exactly the candidate selected by the existing joins.
 * Keeping the CAS in its ON clause bounds D1's expression depth when this fence is
 * composed with independent actor and Wallet checks in an enclosing statement.
 */
function snapshotFenceSql(scopeParts: readonly string[]): string {
  const predicate = scanConjunction([
    ...scopeParts,
    'p.deleted_at IS NULL',
    `(p.release_id IS NULL OR (${issuedPredicate}))`,
    `${snapshotExpressionSql()} IS ?/* scan-ephemeral-template-snapshot */`,
  ]);
  return `EXISTS (SELECT 1 FROM passes p ${snapshotJoins}
    JOIN (SELECT 1) scan_template_guard ON ${predicate})`;
}

/**
 * Batchable standalone capture for callers that have not yet read a Candidate. A later capture
 * cannot replace the original Candidate snapshot: compare the original proof and use the CAS.
 */
export function liveTemplateSnapshotStmt(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
  passId: string,
) {
  return stmt(
    db,
    `SELECT ${liveTemplateSnapshotColumnsSql()} FROM passes p ${snapshotJoins}
    WHERE p.org_id=? AND p.mode=? AND p.id=? AND p.deleted_at IS NULL
      AND (p.release_id IS NULL OR (${issuedPredicate}))`,
    [orgId, mode, passId],
  );
}

export function liveTemplateSnapshotFromRow(
  row: LiveTemplateSnapshotRow,
): LiveTemplateSnapshot | null {
  if (typeof row.live_template_snapshot !== 'string' || !row.live_template_snapshot) return null;
  try {
    const value: unknown = JSON.parse(row.live_template_snapshot);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { raw: row.live_template_snapshot }
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function liveTemplateSnapshotFromResult(
  result: D1Result | undefined,
): LiveTemplateSnapshot | null {
  const rows = result?.results as LiveTemplateSnapshotRow[] | undefined;
  if (rows?.length !== 1) return null;
  const row = rows[0];
  if (row === undefined) throw new TypeError('Missing live template snapshot row');
  return liveTemplateSnapshotFromRow(row);
}

/** Fence a general scanner read to its own original owner and version rows. */
export function scanCandidateTemplateReadPredicate(candidate: Candidate): {
  sql: string;
  params: readonly SqlValue[];
} {
  const snapshot = candidate.templateSnapshot;
  if (!snapshot || !readCandidateTemplateSnapshot(candidate)) return { sql: '0', params: [] };
  return {
    sql: snapshotFenceSql(['p.id=?/* scan-ephemeral-pass-id */', 'p.org_id=?', 'p.mode=?']),
    params: [candidate.pass.id, candidate.pass.orgId, candidate.pass.mode, snapshot.raw],
  };
}

/**
 * Recheck the exact original scope, release, documents, asset metadata and extras in final D1 CAS.
 * The same purpose must be used for the preceding byte/content verification.
 */
export function scanTemplateSnapshotPredicate(
  binding: LiveTemplateBinding,
  snapshot: LiveTemplateSnapshot | null,
  purpose: LiveTemplateSnapshotPurpose,
): { sql: string; params: readonly SqlValue[] } {
  if (!snapshot || !decodeBoundLiveTemplateSnapshot(binding, snapshot, purpose))
    return { sql: '0', params: [] };
  return {
    sql: snapshotFenceSql([
      'p.id=?/* scan-ephemeral-pass-id */',
      'p.org_id=scope.org_id',
      'p.mode=scope.mode',
      'p.org_id=?',
      'p.mode=?',
    ]),
    params: [binding.pass.id, binding.pass.orgId, binding.pass.mode, snapshot.raw],
  };
}
