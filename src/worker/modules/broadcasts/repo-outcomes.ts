import type { Mode } from '../../../shared/contracts/common.ts';
import { all, batch, placeholders, stmt } from '../../platform/db.ts';

type Outcome = 'updated' | 'unchanged' | 'failed';

export interface ItemRow {
  passId: string;
  outcome: Outcome;
  silent: boolean;
}

/** Idempotent: a pass that already has an outcome keeps it. */
export async function insertItems(
  db: D1Database,
  broadcastId: string,
  items: readonly ItemRow[],
): Promise<void> {
  await batch(
    db,
    items.map((i) =>
      stmt(
        db,
        `INSERT OR IGNORE INTO broadcast_items (broadcast_id, pass_id, outcome, silent)
         SELECT ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM broadcasts b JOIN passes p ON p.org_id = b.org_id AND p.mode = b.mode
           WHERE b.id = ? AND p.id = ?
         )`,
        [broadcastId, i.passId, i.outcome, i.silent ? 1 : 0, broadcastId, i.passId],
      ),
    ),
  );
}

export async function handledPassIds(
  db: D1Database,
  broadcastId: string,
  passIds: readonly string[],
): Promise<Set<string>> {
  if (passIds.length === 0) return new Set();
  const rows = await all<{ pass_id: string }>(
    db,
    `SELECT pass_id FROM broadcast_items WHERE broadcast_id = ? AND pass_id IN (${placeholders(passIds.length)})`,
    [broadcastId, ...passIds],
  );
  return new Set(rows.map((r) => r.pass_id));
}

export interface CountRow {
  broadcast_id: string;
  outcome: Outcome;
  silent: number;
  n: number;
}

export const countItems = (
  db: D1Database,
  broadcastIds: readonly string[],
  orgId: string,
  mode: Mode,
) =>
  broadcastIds.length === 0
    ? Promise.resolve([] as CountRow[])
    : all<CountRow>(
        db,
        `SELECT i.broadcast_id, i.outcome, i.silent, COUNT(*) AS n
         FROM broadcast_items i
         JOIN broadcasts b ON b.id = i.broadcast_id
         JOIN passes p ON p.id = i.pass_id AND p.org_id = b.org_id AND p.mode = b.mode
         WHERE b.org_id = ? AND b.mode = ?
           AND i.broadcast_id IN (SELECT value FROM json_each(?))
         GROUP BY i.broadcast_id, i.outcome, i.silent`,
        [orgId, mode, JSON.stringify(broadcastIds)],
      );
