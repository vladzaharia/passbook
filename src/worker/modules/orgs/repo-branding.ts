import { all, first, run } from '../../platform/db.ts';

/** Passes a branding change rebuilds: live, not voided. */
export async function countLivePasses(db: D1Database, orgId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM passes WHERE org_id = ? AND status = 'active' AND deleted_at IS NULL",
    [orgId],
  );
  return row?.n ?? 0;
}

/** Each pass-affecting save moves the mark forward; the reissue waits for it to go quiet. */
export async function markBrandingDirty(db: D1Database, id: string, now: number): Promise<void> {
  await run(db, 'UPDATE orgs SET branding_dirty_at = ? WHERE id = ?', [now, id]);
}

/** Active orgs whose last pass-affecting save is at or before `before`. */
export function quietDirtyOrgs(
  db: D1Database,
  before: number,
  limit: number,
): Promise<{ id: string; at: number }[]> {
  return all<{ id: string; at: number }>(
    db,
    `SELECT id, branding_dirty_at AS at FROM orgs
     WHERE branding_dirty_at IS NOT NULL AND branding_dirty_at <= ? AND status = 'active'
     ORDER BY branding_dirty_at LIMIT ?`,
    [before, limit],
  );
}

/** Takes the mark; false when a newer save moved it or another run took it first. */
export async function claimBrandingDirty(db: D1Database, id: string, at: number): Promise<boolean> {
  const { changes } = await run(
    db,
    'UPDATE orgs SET branding_dirty_at = NULL WHERE id = ? AND branding_dirty_at = ?',
    [id, at],
  );
  return changes === 1;
}
