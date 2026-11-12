import { first } from '../../platform/db.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';

/** The pass's own release is still a valid issued release and its template is not deleted. */
export async function ownReleaseIssued(db: D1Database, passId: string): Promise<boolean> {
  const row = await first(
    db,
    `SELECT 1 FROM passes p WHERE p.id = ? AND EXISTS (SELECT 1 FROM templates ot WHERE ot.id = p.template_id
      AND (ot.org_id IS NULL OR ot.org_id = p.org_id) AND ot.status != 'deleted')
      AND ${issuedReleasePredicateSql(
        { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
        {
          templateIdSql: 'p.template_id',
          orgIdSql: 'p.org_id',
          modeSql: 'p.mode',
          providerSql: "'apple'",
        },
      )}`,
    [passId],
  );
  return row !== null;
}
