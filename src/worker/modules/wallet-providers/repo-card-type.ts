import { first } from '../../platform/db.ts';

/** The Samsung card type of one org's projection release, or null for a release without one. */
export async function releaseCardType(
  db: D1Database,
  orgId: string,
  releaseId: string,
): Promise<string | null> {
  const row = await first<{ card_type: string | null }>(
    db,
    `SELECT CASE WHEN c.provider = 'samsung' THEN COALESCE(json_extract(c.projection_json, '$.cardType'), json_extract(c.projection_json, '$.type')) END AS card_type
    FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = ? AND r.org_id = ?`,
    [releaseId, orgId],
  );
  return row?.card_type ?? null;
}
