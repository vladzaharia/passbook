import { all, first } from '../../platform/db.ts';

/** The tracked places (zones, events) a pass is in now. */
export async function insidePlaces(
  db: D1Database,
  orgId: string,
  passId: string,
): Promise<string[]> {
  const rows = await all<{ scope: string }>(
    db,
    `SELECT scope FROM scan_presence
     WHERE pass_id = ? AND org_id = ? AND state = 'in' AND (scope LIKE 'zone:%' OR scope LIKE 'event:%')`,
    [passId, orgId],
  );
  return rows.map((r) => r.scope);
}

/** When the person last came in to a place, for a replayed answer's stay. */
export async function enteredAt(
  db: D1Database,
  orgId: string,
  passId: string,
  place: string,
): Promise<number | null> {
  const row = await first<{ entered_at: number | null }>(
    db,
    'SELECT COALESCE(entered_at, last_entry_at) AS entered_at FROM scan_presence WHERE org_id = ? AND pass_id = ? AND scope = ?',
    [orgId, passId, place],
  );
  return row?.entered_at ?? null;
}
