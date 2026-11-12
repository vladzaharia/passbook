import { first, run } from '../../platform/db.ts';

export interface IdempotencyRow {
  request_hash: string;
  resource_id: string | null;
  created_at: number;
}

export const idempotencyRow = (db: D1Database, orgId: string, key: string) =>
  first<IdempotencyRow>(
    db,
    'SELECT request_hash, resource_id, created_at FROM idempotency_keys WHERE org_id = ? AND key = ?',
    [orgId, key],
  );

/** Reclaims a key whose first call died: still the same reservation and not settled. */
export async function reclaimIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
  createdAt: number,
  donePrefix: string,
): Promise<void> {
  await run(
    db,
    'DELETE FROM idempotency_keys WHERE org_id = ? AND key = ? AND created_at = ? AND (resource_id IS NULL OR resource_id NOT LIKE ?)',
    [orgId, key, createdAt, `${donePrefix}%`],
  );
}

export async function settleIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
  reservation: string,
  result: string,
): Promise<void> {
  await run(
    db,
    'UPDATE idempotency_keys SET resource_id = ? WHERE org_id = ? AND key = ? AND resource_id = ?',
    [result, orgId, key, reservation],
  );
}
