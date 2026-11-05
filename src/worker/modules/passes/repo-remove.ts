import { first, run } from '../../platform/db.ts';
import type { PassStatus } from './repo.ts';

export interface RemovalState {
  at: number;
  message: string | null;
  priorStatus: PassStatus;
}

export async function getRemoval(db: D1Database, passId: string): Promise<RemovalState | null> {
  const row = await first<{
    removed_at: number | null;
    removal_message: string | null;
    removal_prior_status: string | null;
  }>(db, 'SELECT removed_at, removal_message, removal_prior_status FROM passes WHERE id = ?', [
    passId,
  ]);
  if (!row || row.removed_at === null) return null;
  return {
    at: row.removed_at,
    message: row.removal_message,
    priorStatus: row.removal_prior_status === 'voided' ? 'voided' : 'active',
  };
}

/** Marks a pass removed only if it is not already; false when another call got there first. */
export async function claimRemoval(
  db: D1Database,
  passId: string,
  state: RemovalState,
): Promise<boolean> {
  const res = await run(
    db,
    `UPDATE passes SET removed_at = ?, removal_message = ?, removal_prior_status = ?
     WHERE id = ? AND removed_at IS NULL`,
    [state.at, state.message, state.priorStatus, passId],
  );
  return res.changes > 0;
}

/** Undoes a claim; matches on the claim's own time so another call's removal stays. */
export async function releaseRemoval(db: D1Database, passId: string, at: number): Promise<void> {
  await run(
    db,
    `UPDATE passes SET removed_at = NULL, removal_message = NULL, removal_prior_status = NULL
     WHERE id = ? AND removed_at = ?`,
    [passId, at],
  );
}

/** Takes the removal away only if it is still the one read: two restores cannot both publish. */
export async function claimRestore(
  db: D1Database,
  passId: string,
  removedAt: number,
): Promise<boolean> {
  const res = await run(
    db,
    `UPDATE passes SET removed_at = NULL, removal_message = NULL, removal_prior_status = NULL
     WHERE id = ? AND removed_at = ?`,
    [passId, removedAt],
  );
  return res.changes > 0;
}

/** Undoes a restore claim unless the pass was removed again meanwhile. */
export async function reinstateRemoval(
  db: D1Database,
  passId: string,
  state: RemovalState,
): Promise<void> {
  await run(
    db,
    `UPDATE passes SET removed_at = ?, removal_message = ?, removal_prior_status = ?
     WHERE id = ? AND removed_at IS NULL`,
    [state.at, state.message, state.priorStatus, passId],
  );
}

/** Why the newest version was published; null when it has no source or there is none. */
export async function latestVersionSource(db: D1Database, passId: string): Promise<string | null> {
  const row = await first<{ source: string | null }>(
    db,
    'SELECT source FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  return row?.source ?? null;
}

/** The version the removal published; stays after the pass.removed event is purged. */
export async function removalVersion(db: D1Database, passId: string): Promise<number | null> {
  const row = await first<{ version: number }>(
    db,
    "SELECT version FROM pass_versions WHERE pass_id = ? AND source = 'remove' ORDER BY version DESC LIMIT 1",
    [passId],
  );
  return row?.version ?? null;
}
