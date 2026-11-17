import { first, stmt } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { effectiveReleaseIs, usedRelease } from './effective-release.ts';
import type { Candidate } from './repo-lookup.ts';
import { snapshotReleaseIdSql, usedReleaseIdSql } from './repo-pass-release-sql.ts';
import { predicateStmt } from './scan-predicate.ts';

/** The release id a scan read captured in its template snapshot, null for none or no snapshot. */
export function capturedReleaseId(candidate: Pick<Candidate, 'templateSnapshot'>): string | null {
  const raw = candidate.templateSnapshot?.raw;
  if (!raw) return null;
  const release = (JSON.parse(raw) as { release?: { id?: unknown } | null }).release;
  return typeof release?.id === 'string' ? release.id : null;
}

/**
 * The pass's release changed since the candidate was read: a real race. A newer release that says
 * the same as the pass's own about everything a scanner sees or may do (`ownReleaseSaysSameSql`)
 * changes nothing about how the pass is used.
 */
export async function headMoved(
  db: D1Database,
  candidate: Pick<Candidate, 'pass' | 'templateSnapshot'>,
): Promise<boolean> {
  const row = await first<{ releaseId: string | null }>(
    db,
    `SELECT ${snapshotReleaseIdSql('p', 'ar')} AS releaseId FROM passes p
      LEFT JOIN template_releases ar ON ar.id=(${usedReleaseIdSql('p')})
      WHERE p.id=? AND p.org_id=?`,
    [candidate.pass.id, candidate.pass.orgId],
  );
  return row !== null && row.releaseId !== capturedReleaseId(candidate);
}

export const passChanged = () => new ConflictError('The pass changed. Retry.', 'SCAN_PASS_CHANGED');

/** The captured release id of each pass now, for a batch that may need `headMoved` afterwards. */
export function headReleasesStmt(
  db: D1Database,
  orgId: string,
  passIds: readonly string[],
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT p.id AS id, ${snapshotReleaseIdSql('p', 'ar')} AS releaseId FROM passes p
      LEFT JOIN template_releases ar ON ar.id=(${usedReleaseIdSql('p')})
      WHERE p.org_id=? AND p.id IN (SELECT value FROM json_each(?))`,
    [orgId, JSON.stringify(passIds)],
  );
}

/**
 * Whether the pass the candidate was read under still stands: not deleted, its template not deleted
 * (an archived one keeps its passes working) and used under the release the read captured. A read
 * after a commit. Versions are immutable, so the release id stands for the documents it names.
 */
export function candidateTemplateFenceStmt(db: D1Database, candidate: Candidate) {
  const release = usedRelease(candidate.templateSnapshot?.raw);
  if (release === false) return predicateStmt(db, { sql: '0', params: [] });
  return predicateStmt(db, {
    sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id = ? AND p.org_id = ? AND p.mode = ?
      AND p.deleted_at IS NULL AND ${effectiveReleaseIs('p')}
      AND EXISTS (SELECT 1 FROM templates t WHERE t.id = p.template_id AND t.status != 'deleted'
        AND (t.org_id IS NULL OR t.org_id = p.org_id)))`,
    params: [
      candidate.pass.id,
      candidate.pass.orgId,
      candidate.pass.mode,
      release === null ? null : release[0],
    ],
  });
}

/** The fence's answer, read from the result `candidateTemplateFenceStmt` produced. */
export const templateFenceHolds = (result: D1Result | undefined): boolean =>
  (result?.results?.[0] as { authorized?: number } | undefined)?.authorized === 1;
