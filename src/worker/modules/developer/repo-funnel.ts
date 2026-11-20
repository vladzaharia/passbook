import { first } from '../../platform/db.ts';

export interface Funnel {
  quickstart_viewed_at: number | null;
  first_call_at: number | null;
  first_pass_at: number | null;
  first_preview_at: number | null;
}

export const funnelOf = (db: D1Database, orgId: string) =>
  first<Funnel>(
    db,
    `SELECT quickstart_viewed_at, first_call_at, first_pass_at, first_preview_at
     FROM developer_sandboxes WHERE org_id = ?`,
    [orgId],
  );

/** The earliest call of the sandbox's keys and the earliest pass in it: what the log and the pass table say, not the page. */
export const firstCallAt = async (db: D1Database, orgId: string): Promise<number | null> =>
  (
    await first<{ at: number | null }>(
      db,
      'SELECT MIN(at) AS at FROM request_log WHERE org_id = ?',
      [orgId],
    )
  )?.at ?? null;
export const firstPassAt = async (db: D1Database, orgId: string): Promise<number | null> =>
  (
    await first<{ at: number | null }>(
      db,
      "SELECT MIN(created_at) AS at FROM passes WHERE org_id = ? AND mode = 'test'",
      [orgId],
    )
  )?.at ?? null;
