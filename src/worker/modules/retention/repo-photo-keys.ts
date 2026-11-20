import { all } from '../../platform/db.ts';

/** The R2 keys of the chosen photo rows, read before the rows go. */
export async function photoKeys(
  db: D1Database,
  passIds: readonly string[],
): Promise<{ passId: string; key: string }[]> {
  const rows = await all<{ pass_id: string; r2_key: string }>(
    db,
    'SELECT pass_id, r2_key FROM member_photos WHERE pass_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(passIds)],
  );
  return rows.map((r) => ({ passId: r.pass_id, key: r.r2_key }));
}
