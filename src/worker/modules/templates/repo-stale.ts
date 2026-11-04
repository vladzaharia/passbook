import { all, first, run } from '../../platform/db.ts';

export interface StaleTemplate {
  id: string;
  orgId: string | null;
  /** The active version the passes should move to. */
  version: string;
  /** The active version a rebuild was last queued for. */
  reissued: string | null;
}

/** Active templates whose active version has not been queued yet and has been quiet since `before`. */
export async function quietUnqueuedTemplates(
  db: D1Database,
  before: number,
  limit: number,
): Promise<StaleTemplate[]> {
  const rows = await all<{
    id: string;
    org_id: string | null;
    version: string;
    reissued: string | null;
  }>(
    db,
    `SELECT id, org_id, active_version AS version, reissued_version AS reissued FROM templates
     WHERE status = 'active' AND active_version IS NOT NULL AND updated_at <= ?
       AND reissued_version IS NOT active_version
     ORDER BY updated_at LIMIT ?`,
    [before, limit],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, version: r.version, reissued: r.reissued }));
}

/** Marks `version` as queued; false when the active version moved or another run took it first. */
export async function claimTemplateReissue(db: D1Database, t: StaleTemplate): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE templates SET reissued_version = ?
     WHERE id = ? AND active_version = ? AND reissued_version IS ?`,
    [t.version, t.id, t.version, t.reissued],
  );
  return changes === 1;
}

/** Puts the previous mark back so the next minute retries. */
export async function releaseTemplateReissue(db: D1Database, t: StaleTemplate): Promise<void> {
  await run(db, 'UPDATE templates SET reissued_version = ? WHERE id = ? AND reissued_version = ?', [
    t.reissued,
    t.id,
    t.version,
  ]);
}

/** Live passes on another version than `version`: the ones a rebuild moves. Voided ones never move. */
export async function countStalePasses(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes
     WHERE template_id = ? AND template_version != ? AND status = 'active' AND deleted_at IS NULL`,
    [templateId, version],
  );
  return row?.n ?? 0;
}

/**
 * Live passes still on an older version. `settled` once a rebuild was queued for the active
 * version: what is left then could not move (its fields no longer validate).
 */
export async function olderLivePasses(
  db: D1Database,
  templateId: string,
): Promise<{ older: number; settled: boolean }> {
  const row = await first<{ n: number; settled: number | null }>(
    db,
    `SELECT COUNT(*) AS n, MAX(t.reissued_version = t.active_version) AS settled
     FROM passes p JOIN templates t ON t.id = p.template_id
     WHERE p.template_id = ? AND p.template_version != t.active_version
       AND p.status = 'active' AND p.deleted_at IS NULL`,
    [templateId],
  );
  return { older: row?.n ?? 0, settled: row?.settled === 1 };
}
