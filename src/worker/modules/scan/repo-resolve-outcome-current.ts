import { first, stmt } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import { type OutputPredicate, outputPredicateStmt } from './repo-output-predicates.ts';
import { snapshotReleaseIdSql, usedReleaseIdSql } from './repo-pass-release-sql.ts';

export function currentFoundTemplate(candidate: Candidate): OutputPredicate | null {
  const template = scanCandidateTemplateReadPredicate(candidate);
  return template.sql === '0' ? null : template;
}

export function currentFoundExtra(
  csrf: OutputPredicate,
  template: OutputPredicate,
): OutputPredicate {
  return {
    sql: `(${csrf.sql}) AND (${template.sql})`,
    params: [...csrf.params, ...template.params],
  };
}

export function currentFoundActorStmt(db: D1Database, csrf: OutputPredicate): D1PreparedStatement {
  return stmt(
    db,
    `SELECT CASE WHEN (${csrf.sql}) THEN 1 ELSE 0 END AS actor_authorized`,
    csrf.params,
  );
}

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

/** Whether the template snapshot the candidate was read under still stands: a read after a commit. */
export const candidateTemplateFenceStmt = (db: D1Database, candidate: Candidate) =>
  outputPredicateStmt(db, scanCandidateTemplateReadPredicate(candidate));

/** The fence's answer, read from the result `candidateTemplateFenceStmt` produced. */
export const templateFenceHolds = (result: D1Result | undefined): boolean =>
  (result?.results?.[0] as { authorized?: number } | undefined)?.authorized === 1;
