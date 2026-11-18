import { first } from '../../platform/db.ts';

/** Scans that let this pass in and still stand, apart from `exceptId`: an undo is not one, nor is an undone scan. */
export async function otherStandingScans(
  db: D1Database,
  orgId: string,
  passId: string,
  exceptId: string,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM scans
     WHERE org_id = ? AND pass_id = ? AND id != ? AND state = 'done' AND outcome = 'ok'
       AND undoes IS NULL AND undone_by IS NULL`,
    [orgId, passId, exceptId],
  );
  return row?.n ?? 0;
}
