import type { Mode } from '../../../shared/contracts/common.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';

/** Immutable release fields captured before building a pass artifact. */
export interface PassReleaseSnapshot {
  id: string;
  generation: number;
  orgId: string | null;
  candidateHash: string;
  provider: 'apple';
}

/** Ensure optional bindings in the shared predicate cannot weaken a required snapshot. */
export function validPassReleaseSnapshot(
  release: PassReleaseSnapshot | null | undefined,
): release is PassReleaseSnapshot {
  return (
    !!release &&
    typeof release.id === 'string' &&
    release.id.length > 0 &&
    Number.isSafeInteger(release.generation) &&
    release.generation > 0 &&
    (release.orgId === null || (typeof release.orgId === 'string' && release.orgId.length > 0)) &&
    typeof release.candidateHash === 'string' &&
    release.candidateHash.length > 0 &&
    release.provider === 'apple'
  );
}

const APPLE_SCOPE = {
  templateIdSql: 'pass_scope.template_id',
  orgIdSql: 'pass_scope.org_id',
  modeSql: 'pass_scope.mode',
  providerSql: "'apple'",
} as const;

/**
 * The release is still the one this scope issues from: the head (`effectiveReleaseIdSql`) is this id, and the
 * captured generation, version and candidate hash are the ones the caller built against. Releases are
 * immutable, so those three only guard a hand-built snapshot. A newer release fails it; an unrelated
 * release in another scope does not. Scope expressions are static SQL; values bind once.
 */
export function approvedReleaseFence(
  release: PassReleaseSnapshot,
  templateId: string,
  orgId: string,
  mode: Mode,
  version: string,
): { sql: string; params: SqlValue[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM (SELECT ? AS template_id, ? AS org_id, ? AS mode) pass_scope
      WHERE EXISTS (SELECT 1 FROM orgs o WHERE o.id = pass_scope.org_id AND o.status = 'active')
        AND (${effectiveReleaseIdSql(APPLE_SCOPE)}) = ?
        AND EXISTS (SELECT 1 FROM template_releases r WHERE r.id = ? AND r.generation = ? AND r.version = ?
          AND r.candidate_hash IS ? AND r.org_id IS ?)
    )`,
    params: [
      templateId,
      orgId,
      mode,
      release.id,
      release.id,
      release.generation,
      version,
      release.candidateHash,
      release.orgId,
    ],
  };
}

/** Legacy maintenance can proceed only while this scope has no release at all, in either scope. */
export function noApprovedReleaseFence(
  templateId: string,
  orgId: string,
  mode: Mode,
): { sql: string; params: SqlValue[] } {
  return {
    sql: `NOT EXISTS (
      SELECT 1 FROM template_release_heads h JOIN templates owner ON owner.id = h.template_id
      WHERE h.template_id = ? AND h.mode = ? AND h.provider = 'apple'
        AND (h.org_scope = ? OR (h.org_scope = '' AND owner.org_id IS NULL AND owner.origin = 'baked'))
    )`,
    params: [templateId, mode, orgId],
  };
}

/** Pre-build observation; final writes must use noApprovedReleaseFence again. */
export async function hasNoReleaseHistory(
  db: D1Database,
  templateId: string,
  orgId: string,
  mode: Mode,
): Promise<boolean> {
  const fence = noApprovedReleaseFence(templateId, orgId, mode);
  return (
    (await first<{ ok: number }>(db, `SELECT 1 AS ok WHERE ${fence.sql}`, fence.params)) !== null
  );
}
