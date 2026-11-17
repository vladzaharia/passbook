import { first, stmt } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import { usedReleaseIdSql } from './repo-pass-release-sql.ts';

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

/**
 * A different release version became the head of the pass's template since the candidate was read:
 * a real race. A newer release of the same version changes nothing about how the pass is used.
 */
export async function headVersionMoved(
  db: D1Database,
  candidate: Pick<Candidate, 'pass' | 'activeReleaseVersion'>,
): Promise<boolean> {
  const row = await first<{ version: string | null }>(
    db,
    `SELECT ar.version AS version FROM passes p
      LEFT JOIN template_releases ar ON ar.id=(${usedReleaseIdSql('p')})
      WHERE p.id=? AND p.org_id=?`,
    [candidate.pass.id, candidate.pass.orgId],
  );
  return row !== null && row.version !== candidate.activeReleaseVersion;
}

export const passChanged = () => new ConflictError('The pass changed. Retry.', 'SCAN_PASS_CHANGED');

/** The head version of each pass's template, for a batch that may need `headVersionMoved` afterwards. */
export function headVersionsStmt(
  db: D1Database,
  orgId: string,
  passIds: readonly string[],
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT p.id AS id, ar.version AS version FROM passes p
      LEFT JOIN template_releases ar ON ar.id=(${usedReleaseIdSql('p')})
      WHERE p.org_id=? AND p.id IN (SELECT value FROM json_each(?))`,
    [orgId, JSON.stringify(passIds)],
  );
}
