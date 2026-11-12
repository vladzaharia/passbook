import { all, chunk, placeholders } from '../../platform/db.ts';
import type { Health } from './repo.ts';

/** Passes bound to each connection (list rows). */
export async function passCountsFor(
  db: D1Database,
  connectionIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const ids of chunk(connectionIds)) {
    const rows = await all<{ id: string; n: number }>(
      db,
      `SELECT p.connection_id AS id, count(*) AS n FROM passes p
       JOIN connections c ON c.id = p.connection_id AND c.org_id = p.org_id
       WHERE p.connection_id IN (${placeholders(ids.length)}) AND p.mode = 'live'
         AND p.test_data_quarantined = 0 GROUP BY p.connection_id`,
      ids,
    );
    for (const r of rows) out.set(r.id, r.n);
  }
  return out;
}

export async function summary(db: D1Database, orgId?: string) {
  const params = orgId === undefined ? [] : [orgId];
  const counts = await all<{ health: string; n: number }>(
    db,
    `SELECT health, COUNT(*) AS n FROM connections ${orgId === undefined ? '' : 'WHERE org_id = ?'} GROUP BY health`,
    params,
  );
  const attention = await all<{
    id: string;
    org_id: string;
    name: string;
    health: Health;
    last_error_code: string | null;
    last_error_at: number | null;
  }>(
    db,
    `SELECT id, org_id, name, health, last_error_code, last_error_at FROM connections
     WHERE enabled = 1 AND health IN ('failing', 'degraded')
     ${orgId === undefined ? '' : 'AND org_id = ?'} ORDER BY last_error_at DESC LIMIT 20`,
    params,
  );
  return { counts, attention };
}
