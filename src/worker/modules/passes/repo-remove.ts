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
