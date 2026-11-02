import type { Envelope } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';

// Credentials

export interface CredentialRow {
  id: string;
  orgId: string | null;
  envelope: Envelope;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value as number[]);
}

export async function insertCredential(
  db: D1Database,
  c: {
    id: string;
    orgId: string;
    kind: 'connector' | 'webhook';
    envelope: Envelope;
    fingerprint: string;
    createdBy: string | null;
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.id,
      c.orgId,
      c.kind,
      c.envelope.kekVersion,
      c.envelope.iv,
      c.envelope.wrappedDek,
      c.envelope.ciphertext,
      c.fingerprint,
      c.createdBy,
      c.now,
    ],
  );
}

export async function getCredential(
  db: D1Database,
  orgId: string,
  id: string,
): Promise<CredentialRow | null> {
  const r = await first<{
    id: string;
    org_id: string | null;
    kek_version: number;
    iv: unknown;
    wrapped_dek: unknown;
    ciphertext: unknown;
  }>(
    db,
    'SELECT id, org_id, kek_version, iv, wrapped_dek, ciphertext FROM credentials WHERE id = ? AND org_id = ?',
    [id, orgId],
  );
  if (!r) return null;
  return {
    id: r.id,
    orgId: r.org_id,
    envelope: {
      kekVersion: r.kek_version,
      iv: bytes(r.iv),
      wrappedDek: bytes(r.wrapped_dek),
      ciphertext: bytes(r.ciphertext),
    },
  };
}

export async function deleteCredentials(db: D1Database, ids: (string | null)[]): Promise<void> {
  for (const id of ids) if (id) await run(db, 'DELETE FROM credentials WHERE id = ?', [id]);
}

// Runs

export interface RunRow {
  id: string;
  trigger: 'schedule' | 'webhook' | 'admin' | 'user' | 'test' | 'backfill';
  startedAt: number;
  finishedAt: number | null;
  outcome: 'running' | 'unchanged' | 'changed' | 'error' | 'skipped';
  recordsSeen: number | null;
  passesChanged: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  httpStatus: number | null;
  durationMs: number | null;
}

export async function insertRun(
  db: D1Database,
  r: {
    id: string;
    connectionId: string;
    trigger: string;
    actorId?: string | null;
    passId?: string | null;
    startedAt: number;
  },
): Promise<boolean> {
  const res = await run(
    db,
    `INSERT OR IGNORE INTO connection_runs (id, connection_id, trigger, actor_id, pass_id, started_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, 'running')`,
    [r.id, r.connectionId, r.trigger, r.actorId ?? null, r.passId ?? null, r.startedAt],
  );
  return res.changes === 1;
}

export async function deleteRun(db: D1Database, id: string): Promise<void> {
  await run(db, "DELETE FROM connection_runs WHERE id = ? AND outcome = 'running'", [id]);
}

export async function finishRun(
  db: D1Database,
  r: {
    id: string;
    finishedAt: number;
    outcome: 'unchanged' | 'changed' | 'error' | 'skipped';
    recordsSeen: number;
    passesChanged: number;
    errorCode: string | null;
    errorDetail: string | null;
    httpStatus: number | null;
  },
): Promise<void> {
  await run(
    db,
    `UPDATE connection_runs SET finished_at = ?, outcome = ?, records_seen = ?, passes_changed = ?,
       error_code = ?, error_detail = ?, http_status = ?, duration_ms = ? - started_at
     WHERE id = ? AND outcome = 'running'`,
    [
      r.finishedAt,
      r.outcome,
      r.recordsSeen,
      r.passesChanged,
      r.errorCode,
      r.errorDetail,
      r.httpStatus,
      r.finishedAt,
      r.id,
    ],
  );
}

export async function listRuns(
  db: D1Database,
  connectionId: string,
  q: { cursor?: string | undefined; limit: number },
): Promise<RunRow[]> {
  const rows = await all<{
    id: string;
    trigger: string;
    started_at: number;
    finished_at: number | null;
    outcome: string;
    records_seen: number | null;
    passes_changed: number | null;
    error_code: string | null;
    error_detail: string | null;
    http_status: number | null;
    duration_ms: number | null;
  }>(
    db,
    `SELECT id, trigger, started_at, finished_at, outcome, records_seen, passes_changed, error_code, error_detail, http_status, duration_ms
     FROM connection_runs WHERE connection_id = ?
       ${q.cursor ? 'AND (started_at, id) < (SELECT started_at, id FROM connection_runs WHERE id = ?)' : ''}
     ORDER BY started_at DESC, id DESC LIMIT ?`,
    q.cursor ? [connectionId, q.cursor, q.limit] : [connectionId, q.limit],
  );
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger as RunRow['trigger'],
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    outcome: r.outcome as RunRow['outcome'],
    recordsSeen: r.records_seen,
    passesChanged: r.passes_changed,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    httpStatus: r.http_status,
    durationMs: r.duration_ms,
  }));
}

export async function runStats(db: D1Database, connectionId: string) {
  const rows = await all<{ outcome: string; duration_ms: number | null }>(
    db,
    `SELECT outcome, duration_ms FROM connection_runs
     WHERE connection_id = ? AND outcome != 'running' AND trigger IN ('schedule', 'webhook', 'admin')
     ORDER BY started_at DESC, id DESC LIMIT 100`,
    [connectionId],
  );
  const passCount = await first<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM passes WHERE connection_id = ?',
    [connectionId],
  );
  return { rows, passCount: passCount?.n ?? 0 };
}
