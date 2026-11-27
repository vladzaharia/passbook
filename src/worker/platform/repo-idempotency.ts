import { first, run } from './db.ts';

export interface IdempotentRow {
  request_hash: string;
  status: number | null;
  body: string | null;
  created_at: number;
}

/** (org, mode, principal, operation, key). */
export type IdempotencyId = readonly [string, string, string, string, string];

const WHERE = 'org_id = ? AND mode = ? AND principal = ? AND operation = ? AND key = ?';

export async function claimRequest(
  db: D1Database,
  id: IdempotencyId,
  hash: string,
  now: number,
  expiresAt: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `INSERT OR IGNORE INTO idempotent_requests
       (org_id, mode, principal, operation, key, request_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [...id, hash, now, expiresAt],
  );
  return changes > 0;
}

export const requestRow = (db: D1Database, id: IdempotencyId) =>
  first<IdempotentRow>(
    db,
    `SELECT request_hash, status, body, created_at FROM idempotent_requests WHERE ${WHERE}`,
    id,
  );

/** Drops an unsettled claim of one call (its own, or a dead one identified by `createdAt`). */
export async function dropUnsettled(
  db: D1Database,
  id: IdempotencyId,
  by: { hash: string } | { createdAt: number },
): Promise<void> {
  const [clause, value] =
    'hash' in by ? ['request_hash = ?', by.hash] : ['created_at = ?', by.createdAt];
  await run(db, `DELETE FROM idempotent_requests WHERE ${WHERE} AND ${clause} AND status IS NULL`, [
    ...id,
    value,
  ]);
}

export async function settleRequest(
  db: D1Database,
  id: IdempotencyId,
  status: number,
  body: string,
): Promise<void> {
  await run(
    db,
    `UPDATE idempotent_requests SET status = ?, body = ? WHERE ${WHERE} AND status IS NULL`,
    [status, body, ...id],
  );
}

/** `settleRequest` as a statement, for a batch that commits the answer with the work it answers. */
export const settleStatement = (
  db: D1Database,
  id: IdempotencyId,
  status: number,
  body: string,
): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE idempotent_requests SET status = ?, body = ? WHERE ${WHERE} AND status IS NULL`,
    )
    .bind(status, body, ...id);

export async function deleteExpiredRequests(
  db: D1Database,
  now: number,
  limit: number,
): Promise<number> {
  return (
    await run(
      db,
      `DELETE FROM idempotent_requests WHERE (org_id, mode, principal, operation, key) IN
         (SELECT org_id, mode, principal, operation, key FROM idempotent_requests
          WHERE expires_at < ? ORDER BY expires_at LIMIT ?)`,
      [now, limit],
    )
  ).changes;
}
