import { all, run } from '../../platform/db.ts';

export interface QueuedBrandingKey {
  orgId: string;
  key: string;
}

/** Queues superseded keys; a key queued twice keeps its latest supersede time. */
export async function queueBrandingKeys(
  db: D1Database,
  orgId: string,
  keys: readonly string[],
  at: number,
): Promise<void> {
  for (const key of keys) {
    await run(
      db,
      `INSERT INTO branding_gc_queue (org_id, r2_key, superseded_at) VALUES (?, ?, ?)
       ON CONFLICT (org_id, r2_key) DO UPDATE SET superseded_at = excluded.superseded_at`,
      [orgId, key, at],
    );
  }
}

export function dueBrandingKeys(
  db: D1Database,
  before: number,
  limit: number,
): Promise<QueuedBrandingKey[]> {
  return all<QueuedBrandingKey>(
    db,
    `SELECT org_id AS orgId, r2_key AS key FROM branding_gc_queue
     WHERE superseded_at <= ? ORDER BY superseded_at LIMIT ?`,
    [before, limit],
  );
}

export async function currentBranding(db: D1Database, orgId: string): Promise<string | null> {
  const rows = await all<{ branding: string }>(db, 'SELECT branding FROM orgs WHERE id = ?', [
    orgId,
  ]);
  return rows[0]?.branding ?? null;
}

export async function dropBrandingKey(db: D1Database, orgId: string, key: string): Promise<void> {
  await run(db, 'DELETE FROM branding_gc_queue WHERE org_id = ? AND r2_key = ?', [orgId, key]);
}
