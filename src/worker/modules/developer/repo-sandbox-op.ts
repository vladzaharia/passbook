import { first } from '../../platform/db.ts';

/** The sandbox key the person holds now, if any. A revoked one does not count: it was shown once, and is gone. */
export const liveSandboxKeyOf = (db: D1Database, orgId: string, userId: string, name: string) =>
  first<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM api_keys WHERE org_id = ? AND created_by = ? AND name = ? AND kind = 'personal'
       AND revoked_at IS NULL ORDER BY created_at LIMIT 1`,
    [orgId, userId, name],
  );

/** Keys a delete will revoke: every key of the org that is still live. */
export const liveKeyCount = async (db: D1Database, orgId: string): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL',
      [orgId],
    )
  )?.n ?? 0;

/** Passes the purge's void pass still has to do: every live pass that is not voided yet. */
export const unvoidedPassCount = async (db: D1Database, orgId: string): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM passes WHERE org_id = ? AND deleted_at IS NULL
         AND NOT (removed_at IS NOT NULL AND status = 'voided')`,
      [orgId],
    )
  )?.n ?? 0;

/** Test passes a reset visits, soft-deleted ones too. */
export const resetPassTotal = async (db: D1Database, orgId: string): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM passes WHERE org_id = ? AND mode = 'test'",
      [orgId],
    )
  )?.n ?? 0;

/** Captured webhook calls a reset removes. */
export const captureTotal = async (db: D1Database, orgId: string, stamp: number): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM webhook_captures WHERE org_id = ? AND created_at <= ?',
      [orgId, stamp],
    )
  )?.n ?? 0;

/** An org id already in use (a deleted sandbox's org keeps its row): a retried create must not insert it again. */
export const orgExists = async (db: D1Database, orgId: string): Promise<boolean> =>
  (await first(db, 'SELECT 1 AS x FROM orgs WHERE id = ?', [orgId])) !== null;
