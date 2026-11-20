import { all, first } from '../../platform/db.ts';

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

/** The rollback candidate a photo row's delete trigger staged for its object. */
export async function stagedCandidateId(
  db: D1Database,
  passId: string,
  key: string,
): Promise<number | undefined> {
  const row = await first<{ id: number }>(
    db,
    'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ? ORDER BY id DESC LIMIT 1',
    [passId, key],
  );
  return row?.id;
}
