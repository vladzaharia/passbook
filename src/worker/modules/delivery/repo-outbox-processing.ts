import { deleteInBatches } from '../../platform/batched.ts';
import { all, chunk, first, placeholders, run } from '../../platform/db.ts';
import { mapOutbox, type OutboxDbRow, type OutboxRow } from './repo-outbox-map.ts';

/** Marks due rows `enqueued` before sending, so repeated dispatches never double-send. */
export async function markDueEnqueued(
  db: D1Database,
  now: number,
  limit: number,
  passId?: string,
): Promise<{ id: string; kind: 'push' | 'email' }[]> {
  return all<{ id: string; kind: 'push' | 'email' }>(
    db,
    `UPDATE outbox SET state = 'enqueued', enqueued_at = ?
     WHERE id IN (SELECT o.id FROM outbox o WHERE o.state = 'pending' AND o.available_at <= ?
                  AND (? IS NULL OR o.pass_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
                    WHERE t.pass_id = o.pass_id AND t.state = 'pending')
                  ORDER BY o.available_at, o.created_at LIMIT ?)
     RETURNING id, kind`,
    [now, now, passId ?? null, passId ?? null, limit],
  );
}

export async function revertEnqueued(db: D1Database, ids: string[]): Promise<void> {
  for (const part of chunk(ids)) {
    await run(
      db,
      `UPDATE outbox SET state = 'pending', enqueued_at = NULL WHERE state = 'enqueued' AND id IN (${placeholders(part.length)})`,
      part,
    );
  }
}

/** Takes the lease. `available_at` doubles as the lease expiry while processing. */
export async function claimOutbox(
  db: D1Database,
  id: string,
  lease: string,
  now: number,
  leaseMs: number,
): Promise<OutboxRow | null> {
  const row = await first<OutboxDbRow>(
    db,
    `UPDATE outbox SET state = 'processing', attempts = attempts + 1, lease = ?, available_at = ?,
       coalesce_key = NULL
     WHERE id = ? AND attempts < max_attempts AND state IN ('pending', 'enqueued') RETURNING *`,
    [lease, now + leaseMs, id],
  );
  return row ? mapOutbox(row) : null;
}

/** Back to `enqueued` so the redelivered message can claim it again. */
export async function releaseOutbox(
  db: D1Database,
  id: string,
  lease: string,
  retryAt: number,
  errorCode: string,
): Promise<void> {
  await run(
    db,
    `UPDATE outbox SET state = 'enqueued', lease = NULL, enqueued_at = ?, error_code = ?
     WHERE id = ? AND lease = ?`,
    [retryAt, errorCode, id, lease],
  );
}

export async function finishOutbox(
  db: D1Database,
  id: string,
  lease: string,
  state: 'sent' | 'partial' | 'failed' | 'cancelled',
  now: number,
  errorCode: string | null,
  providerId: string | null = null,
): Promise<void> {
  await run(
    db,
    `UPDATE outbox SET state = ?, lease = NULL, finished_at = ?, error_code = ?, provider_id = ?,
       coalesce_key = NULL
     WHERE id = ? AND lease = ?`,
    [state, now, errorCode, providerId, id, lease],
  );
}

/** Marks a row failed without holding its lease (DLQ, exhausted attempts). */
export async function failOutbox(
  db: D1Database,
  id: string,
  now: number,
  errorCode: string,
): Promise<OutboxRow | null> {
  const row = await first<OutboxDbRow>(
    db,
    `UPDATE outbox SET state = 'failed', lease = NULL, finished_at = ?, error_code = ?, coalesce_key = NULL
     WHERE id = ? AND state IN ('pending', 'enqueued', 'processing')
       AND (kind != 'email' OR (coalesce(error_code, '') != 'EMAIL_OUTCOME_UNKNOWN' AND provider_id IS NULL))
     RETURNING *`,
    [now, errorCode, id],
  );
  return row ? mapOutbox(row) : null;
}

/** Fails a row only when its attempts are used up; a row another consumer released stays. */
export async function failExhausted(db: D1Database, id: string, now: number): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE outbox SET state = 'failed', lease = NULL, finished_at = ?, error_code = 'MAX_ATTEMPTS',
       coalesce_key = NULL
     WHERE id = ? AND state IN ('pending', 'enqueued') AND attempts >= max_attempts`,
    [now, id],
  );
  return result.changes > 0;
}

/** Leases that expired while processing: retry, or fail when attempts are used up. */
export async function reclaimStaleLeases(
  db: D1Database,
  now: number,
): Promise<{ retried: number; failed: number }> {
  const failed = await run(
    db,
    `UPDATE outbox SET state = 'failed', lease = NULL, finished_at = ?, error_code = 'LEASE_EXPIRED', coalesce_key = NULL
     WHERE state = 'processing' AND available_at < ? AND attempts >= max_attempts`,
    [now, now],
  );
  const retried = await run(
    db,
    `UPDATE outbox SET state = 'pending', lease = NULL, available_at = 0
     WHERE state = 'processing' AND available_at < ? AND attempts < max_attempts`,
    [now],
  );
  return { retried: retried.changes, failed: failed.changes };
}

/** Rows marked `enqueued` whose message never arrived (send failed after commit, queue loss). */
export async function lostEnqueues(
  db: D1Database,
  olderThan: number,
  limit: number,
): Promise<{ id: string; kind: 'push' | 'email' }[]> {
  return all<{ id: string; kind: 'push' | 'email' }>(
    db,
    `SELECT id, kind FROM outbox WHERE state = 'enqueued' AND enqueued_at < ? ORDER BY enqueued_at LIMIT ?`,
    [olderThan, limit],
  );
}

export async function touchEnqueued(db: D1Database, ids: string[], now: number): Promise<void> {
  for (const part of chunk(ids)) {
    await run(
      db,
      `UPDATE outbox SET enqueued_at = ? WHERE state = 'enqueued' AND id IN (${placeholders(part.length)})`,
      [now, ...part],
    );
  }
}

export async function deleteFinishedOutbox(
  db: D1Database,
  sentBefore: number,
  failedBefore: number,
): Promise<number> {
  const sent = await deleteInBatches(
    db,
    'outbox',
    `state IN ('sent', 'cancelled') AND finished_at < ?`,
    [sentBefore],
  );
  const failed = await deleteInBatches(
    db,
    'outbox',
    `state IN ('failed', 'partial') AND finished_at < ?`,
    [failedBefore],
  );
  return sent + failed;
}
