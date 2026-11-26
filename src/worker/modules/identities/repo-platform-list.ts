import { all } from '../../platform/db.ts';

/** Devices that registered a pass, per platform identity (no org). */
export async function platformRegistrationCounts(db: D1Database): Promise<Map<string, number>> {
  const rows = await all<{ identity_id: string; n: number }>(
    db,
    `SELECT identity_id, count(*) AS n FROM registrations
     WHERE identity_id IN (SELECT id FROM signing_identities WHERE org_id IS NULL)
     GROUP BY identity_id`,
  );
  return new Map(rows.map((r) => [r.identity_id, r.n]));
}
