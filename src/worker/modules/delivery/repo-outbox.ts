import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all, chunk, first, placeholders, run } from '../../platform/db.ts';

export type OutboxState =
  | 'pending'
  | 'enqueued'
  | 'processing'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface OutboxRow {
  id: string;
  orgId: string;
  kind: 'push' | 'email';
  passId: string | null;
  payload: Record<string, unknown>;
  state: OutboxState;
  attempts: number;
  maxAttempts: number;
  lease: string | null;
  errorCode: string | null;
  providerId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

interface OutboxDbRow {
  id: string;
  org_id: string;
  kind: 'push' | 'email';
  pass_id: string | null;
  payload: string;
  state: OutboxState;
  attempts: number;
  max_attempts: number;
  lease: string | null;
  error_code: string | null;
  provider_id: string | null;
  created_at: number;
  finished_at: number | null;
}

const mapOutbox = (r: OutboxDbRow): OutboxRow => ({
  id: r.id,
  orgId: r.org_id,
  kind: r.kind,
  passId: r.pass_id,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  state: r.state,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  lease: r.lease,
  errorCode: r.error_code,
  providerId: r.provider_id,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export async function getOutbox(db: D1Database, id: string): Promise<OutboxRow | null> {
  const row = await first<OutboxDbRow>(db, 'SELECT * FROM outbox WHERE id = ?', [id]);
  return row ? mapOutbox(row) : null;
}

export async function listOutboxForPass(
  db: D1Database,
  passId: string,
  limit = 20,
): Promise<OutboxRow[]> {
  const rows = await all<OutboxDbRow>(
    db,
    'SELECT * FROM outbox WHERE pass_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [passId, limit],
  );
  return rows.map(mapOutbox);
}

export interface NewOutbox {
  id: string;
  orgId: string;
  kind: 'push' | 'email';
  passId: string;
  coalesceKey: string | null;
  payload: Record<string, unknown>;
  now: number;
}

/** Returns false when a pending push for the same pass already exists (coalesced). */
export async function insertOutbox(db: D1Database, row: NewOutbox): Promise<boolean> {
  const result = await run(
    db,
    `INSERT OR IGNORE INTO outbox (id, org_id, kind, pass_id, coalesce_key, payload, state, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      row.id,
      row.orgId,
      row.kind,
      row.passId,
      row.coalesceKey,
      JSON.stringify(row.payload),
      row.now,
    ],
  );
  return result.changes === 1;
}

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
     WHERE id IN (SELECT id FROM outbox WHERE state = 'pending' AND available_at <= ?
                  AND (? IS NULL OR pass_id = ?) ORDER BY available_at, created_at LIMIT ?)
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
     WHERE id = ? AND state IN ('pending', 'enqueued', 'processing') RETURNING *`,
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

/** Records the provider's message id before the row is finished, so a re-run never re-sends. */
export async function setProviderId(
  db: D1Database,
  id: string,
  lease: string,
  providerId: string,
): Promise<void> {
  await run(db, 'UPDATE outbox SET provider_id = ? WHERE id = ? AND lease = ?', [
    providerId,
    id,
    lease,
  ]);
}

export interface OrgBranding {
  accent?: string;
  supportEmail?: string;
  supportUrl?: string;
}

/** orgs.branding as written by the org form. Invalid JSON reads as empty. */
export async function orgBranding(db: D1Database, orgId: string): Promise<OrgBranding> {
  const row = await first<{ branding: string }>(db, 'SELECT branding FROM orgs WHERE id = ?', [
    orgId,
  ]);
  if (!row) return {};
  const parsed = OrgBrandingSchema.safeParse(JSON.parse(row.branding));
  return parsed.success ? parsed.data : {};
}

export { bump as bumpCounter } from '../../platform/counters.ts';
