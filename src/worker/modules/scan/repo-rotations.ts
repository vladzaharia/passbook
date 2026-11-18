import { first } from '../../platform/db.ts';

/** Whether any of these keyed code hashes is a scan code that a New code rotated out, in this org and mode. */
export async function codeRotatedOut(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
  refs: readonly string[],
): Promise<boolean> {
  if (refs.length === 0) return false;
  const row = await first(
    db,
    `SELECT 1 AS hit FROM scan_code_rotations
     WHERE org_id = ? AND mode = ? AND old_code_hash IN (SELECT value FROM json_each(?)) LIMIT 1`,
    [orgId, mode, JSON.stringify(refs)],
  );
  return row !== null;
}
