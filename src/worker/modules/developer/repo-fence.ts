import { first } from '../../platform/db.ts';

/** True for a developer org. An unknown org is not one (the caller's own org checks refuse it). */
export async function isPreviewOnlyOrg(db: D1Database, orgId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    "SELECT 1 AS ok FROM orgs WHERE id = ? AND kind = 'developer'",
    [orgId],
  );
  return row !== null;
}

/** SQL form: true for an org that is not a developer org. `orgSql` is a trusted column. */
export const notPreviewOnlySql = (orgSql: string): string =>
  `NOT EXISTS (SELECT 1 FROM orgs dev_o WHERE dev_o.id = ${orgSql} AND dev_o.kind = 'developer')`;
