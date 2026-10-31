import { all, batch, chunk, first, placeholders, run, stmt } from '../../platform/db.ts';

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

export interface DeviceTarget {
  deviceId: string;
  pushToken: string;
}

export async function devicesForPass(
  db: D1Database,
  passId: string,
  identityId: string,
): Promise<DeviceTarget[]> {
  const rows = await all<{ device_id: string; push_token: string }>(
    db,
    `SELECT d.device_id, d.push_token FROM registrations r
     JOIN devices d ON d.device_id = r.device_id AND d.identity_id = r.identity_id
     WHERE r.pass_id = ? AND r.identity_id = ? ORDER BY r.created_at`,
    [passId, identityId],
  );
  return rows.map((r) => ({ deviceId: r.device_id, pushToken: r.push_token }));
}

export async function deliveredDevices(db: D1Database, outboxId: string): Promise<Set<string>> {
  const rows = await all<{ device_id: string }>(
    db,
    'SELECT device_id FROM push_results WHERE outbox_id = ? AND http_status = 200',
    [outboxId],
  );
  return new Set(rows.map((r) => r.device_id));
}

export interface PushResultRow {
  deviceId: string;
  httpStatus: number | null;
  reason: string | null;
  apnsId: string | null;
}

export async function savePushResults(
  db: D1Database,
  outboxId: string,
  rows: PushResultRow[],
  now: number,
): Promise<void> {
  await batch(
    db,
    rows.map((r) =>
      stmt(
        db,
        `INSERT OR REPLACE INTO push_results (outbox_id, device_id, http_status, reason, apns_id, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [outboxId, r.deviceId, r.httpStatus, r.reason, r.apnsId, now],
      ),
    ),
  );
}

/** Removes the registration and, when it was the device's last, the device itself. */
export async function dropRegistrations(
  db: D1Database,
  passId: string,
  identityId: string,
  deviceIds: string[],
): Promise<void> {
  await batch(db, [
    ...deviceIds.map((id) =>
      stmt(
        db,
        'DELETE FROM registrations WHERE pass_id = ? AND identity_id = ? AND device_id = ?',
        [passId, identityId, id],
      ),
    ),
    ...deviceIds.map((id) =>
      stmt(
        db,
        `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
         AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.device_id = ? AND r.identity_id = ?)`,
        [id, identityId, id, identityId],
      ),
    ),
  ]);
}

export async function setApnsHealth(
  db: D1Database,
  identityId: string,
  health: 'healthy' | 'failing',
): Promise<void> {
  await run(db, 'UPDATE signing_identities SET apns_health = ? WHERE id = ? AND apns_health != ?', [
    health,
    identityId,
    health,
  ]);
}

export async function deleteFinishedOutbox(
  db: D1Database,
  sentBefore: number,
  failedBefore: number,
): Promise<number> {
  const sent = await run(
    db,
    `DELETE FROM outbox WHERE state IN ('sent', 'cancelled') AND finished_at < ?`,
    [sentBefore],
  );
  const failed = await run(
    db,
    `DELETE FROM outbox WHERE state IN ('failed', 'partial') AND finished_at < ?`,
    [failedBefore],
  );
  return sent.changes + failed.changes;
}
