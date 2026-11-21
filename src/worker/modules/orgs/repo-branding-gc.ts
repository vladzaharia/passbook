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

/**
 * Queues a staged upload's keys while the org has fewer than `cap` queued: the count and the insert are one
 * statement, so concurrent stages cannot pass the cap. False when the cap stopped it.
 */
export async function queueStagedKeys(
  db: D1Database,
  orgId: string,
  keys: readonly string[],
  at: number,
  cap: number,
): Promise<boolean> {
  for (const key of keys) {
    const { changes } = await run(
      db,
      `INSERT INTO branding_gc_queue (org_id, r2_key, superseded_at)
       SELECT ?, ?, ? WHERE (SELECT count(*) FROM branding_gc_queue WHERE org_id = ?) < ?
       ON CONFLICT (org_id, r2_key) DO UPDATE SET superseded_at = excluded.superseded_at`,
      [orgId, key, at, orgId, cap],
    );
    if (changes === 0) return false;
  }
  return true;
}

/** Takes a due row: false when a newer save moved it or another sweep took it. */
export async function claimBrandingKey(
  db: D1Database,
  orgId: string,
  key: string,
  before: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    'DELETE FROM branding_gc_queue WHERE org_id = ? AND r2_key = ? AND superseded_at <= ?',
    [orgId, key, before],
  );
  return changes === 1;
}

/** Whether a save queued the key again since it was claimed. */
export async function isBrandingKeyQueued(
  db: D1Database,
  orgId: string,
  key: string,
): Promise<boolean> {
  const rows = await all<{ n: number }>(
    db,
    'SELECT 1 AS n FROM branding_gc_queue WHERE org_id = ? AND r2_key = ?',
    [orgId, key],
  );
  return rows.length > 0;
}
