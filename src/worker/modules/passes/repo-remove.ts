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

export async function setRemoval(
  db: D1Database,
  passId: string,
  state: RemovalState | null,
): Promise<void> {
  await run(
    db,
    'UPDATE passes SET removed_at = ?, removal_message = ?, removal_prior_status = ? WHERE id = ?',
    [state?.at ?? null, state?.message ?? null, state?.priorStatus ?? null, passId],
  );
}
