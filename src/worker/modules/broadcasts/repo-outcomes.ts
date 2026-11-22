import type { Mode } from '../../../shared/contracts/common.ts';
import { all, batch, first, placeholders, run, stmt } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';

type Outcome = 'updated' | 'unchanged' | 'failed';

export interface ItemRow {
  passId: string;
  outcome: Outcome;
  silent: boolean;
  /** A change run's `{from, to}` of the touched inputs (JSON), which its undo restores. */
  before?: string | null;
  /** The pass version the run wrote. */
  version?: number | null;
}

/** Idempotent: a pass that already has an outcome keeps it. */
export async function insertItems(
  db: D1Database,
  broadcastId: string,
  items: readonly ItemRow[],
): Promise<void> {
  await batch(
    db,
    items.flatMap((i) => [
      stmt(
        db,
        `INSERT OR IGNORE INTO broadcast_items (broadcast_id, pass_id, outcome, silent, before, version)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM broadcasts b JOIN passes p ON p.org_id = b.org_id AND p.mode = b.mode
           WHERE b.id = ? AND p.id = ?
         )`,
        [
          broadcastId,
          i.passId,
          i.outcome,
          i.silent ? 1 : 0,
          i.before ?? null,
          i.version ?? null,
          broadcastId,
          i.passId,
        ],
      ),
      // The item and the end of the pass's write-ahead intent commit together.
      stmt(
        db,
        'UPDATE broadcast_targets SET intent = NULL WHERE broadcast_id = ? AND pass_id = ? AND intent IS NOT NULL',
        [broadcastId, i.passId],
      ),
    ]),
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

/** Writes what a change is about to do to a pass, before it does it (see `broadcast_targets.intent`). */
export async function setIntent(
  db: D1Database,
  broadcastId: string,
  passId: string,
  intent: string,
): Promise<void> {
  const { changes } = await run(
    db,
    `UPDATE broadcast_targets SET intent = ?
     WHERE broadcast_id = ? AND pass_id = ? AND intent IS NULL
       AND NOT EXISTS (SELECT 1 FROM broadcast_items i
         WHERE i.broadcast_id = broadcast_targets.broadcast_id AND i.pass_id = broadcast_targets.pass_id)`,
    [intent, broadcastId, passId],
  );
  if (changes > 0) return;
  // Each refusal is its own case: no row means no stamp from the write (a crash would apply the change
  // twice); a live intent is another attempt's; a recorded item means a newer attempt finished the pass.
  const row = await first<{ intent: string | null; recorded: number }>(
    db,
    `SELECT t.intent, EXISTS (SELECT 1 FROM broadcast_items i
       WHERE i.broadcast_id = t.broadcast_id AND i.pass_id = t.pass_id) AS recorded
     FROM broadcast_targets t WHERE t.broadcast_id = ? AND t.pass_id = ?`,
    [broadcastId, passId],
  );
  if (!row) throw new ConflictError('The pass is not a target of this run.', 'INTENT_NO_TARGET');
  if (row.recorded)
    throw new ConflictError('This run already recorded the pass.', 'INTENT_ITEM_RECORDED');
  throw new ConflictError('Another attempt holds the pass.', 'INTENT_LIVE');
}

export const clearIntent = (db: D1Database, broadcastId: string, passId: string) =>
  run(db, 'UPDATE broadcast_targets SET intent = NULL WHERE broadcast_id = ? AND pass_id = ?', [
    broadcastId,
    passId,
  ]);

/** Passes with an intent and no item: a step died between writing the pass and recording it. */
export const pendingIntents = (
  db: D1Database,
  broadcastId: string,
  limit: number,
  passId?: string,
) =>
  all<{ pass_id: string; intent: string }>(
    db,
    `SELECT t.pass_id, t.intent FROM broadcast_targets t WHERE t.broadcast_id = ? AND t.intent IS NOT NULL${passId ? ' AND t.pass_id = ?' : ''}
       AND NOT EXISTS (SELECT 1 FROM broadcast_items i WHERE i.broadcast_id = t.broadcast_id AND i.pass_id = t.pass_id)
     ORDER BY t.pass_id LIMIT ?`,
    passId ? [broadcastId, passId, limit] : [broadcastId, limit],
  ) as Promise<{ pass_id: string; intent: string }[]>;
