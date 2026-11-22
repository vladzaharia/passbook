import type { Mode } from '../../../shared/contracts/common.ts';
import { type PassView, PassViewListSchema } from '../../../shared/contracts/pass-views.ts';
import { first, run } from '../../platform/db.ts';

/** The org's saved views for a mode, with the revision to send back; a stored value that no longer parses reads as none. */
export async function readPassViews(
  db: D1Database,
  orgId: string,
  mode: Mode,
): Promise<{ items: PassView[]; revision: number }> {
  const row = await first<{ items: string; revision: number }>(
    db,
    'SELECT items, revision FROM pass_views WHERE org_id = ? AND mode = ?',
    [orgId, mode],
  );
  if (!row) return { items: [], revision: 0 };
  const parsed = PassViewListSchema.shape.items.safeParse(JSON.parse(row.items));
  return { items: parsed.success ? parsed.data : [], revision: row.revision };
}

/** Saves the list when `revision` is still the stored one (0: none stored yet); false when it moved. */
export async function writePassViews(
  db: D1Database,
  orgId: string,
  mode: Mode,
  items: PassView[],
  revision: number,
  now: number,
): Promise<boolean> {
  const json = JSON.stringify(items);
  const result =
    revision === 0
      ? await run(
          db,
          `INSERT INTO pass_views (org_id, mode, revision, items, moved_at) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (org_id, mode) DO NOTHING`,
          [orgId, mode, json, now],
        )
      : await run(
          db,
          `UPDATE pass_views SET items = ?, revision = revision + 1, moved_at = ?
           WHERE org_id = ? AND mode = ? AND revision = ?`,
          [json, now, orgId, mode, revision],
        );
  return result.changes === 1;
}
