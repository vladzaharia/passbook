import { all, first, run } from '../../platform/db.ts';

/** A claim on a due row holds it from other ticks this long; a lost run is retried after. */
export const BOUNDARY_LEASE_MS = 5 * 60_000;

/** Rows whose date is still to be worked out (`due_at` 0). */
export function unsettledBoundaries(db: D1Database, limit: number): Promise<{ passId: string }[]> {
  return all(
    db,
    'SELECT pass_id AS passId FROM pass_boundaries WHERE due_at = 0 ORDER BY pass_id LIMIT ?',
    [limit],
  );
}

/** Rows whose boundary has passed, oldest first. */
export function dueBoundaries(
  db: D1Database,
  now: number,
  limit: number,
): Promise<{ passId: string; dueAt: number }[]> {
  return all(
    db,
    `SELECT pass_id AS passId, due_at AS dueAt FROM pass_boundaries
     WHERE due_at > 0 AND due_at <= ? ORDER BY due_at, pass_id LIMIT ?`,
    [now, limit],
  );
}

/** Moves a row from the value read to a new one; false when another tick or a new version got there first. */
export async function moveBoundary(
  db: D1Database,
  passId: string,
  from: number,
  to: number | null,
): Promise<boolean> {
  const { changes } =
    to === null
      ? await run(db, 'DELETE FROM pass_boundaries WHERE pass_id = ? AND due_at = ?', [
          passId,
          from,
        ])
      : await run(db, 'UPDATE pass_boundaries SET due_at = ? WHERE pass_id = ? AND due_at = ?', [
          to,
          passId,
          from,
        ]);
  return changes > 0;
}

/** The row goes with the pass that can no longer change. */
export async function dropBoundary(db: D1Database, passId: string): Promise<void> {
  await run(db, 'DELETE FROM pass_boundaries WHERE pass_id = ?', [passId]);
}

export async function latestPassJson(db: D1Database, passId: string): Promise<string | null> {
  const row = await first<{ pass_json: string | null }>(
    db,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  return row?.pass_json ?? null;
}
