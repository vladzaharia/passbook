import { first } from '../../platform/db.ts';

/** The pass that replaced `passId` in an identity move, once the move voided it; null before that. */
export async function replacedByOf(db: D1Database, passId: string): Promise<string | null> {
  const row = await first<{ replaced_by: string }>(
    db,
    'SELECT replaced_by FROM pass_moves WHERE old_pass_id = ? AND replaced_by IS NOT NULL',
    [passId],
  );
  return row?.replaced_by ?? null;
}
