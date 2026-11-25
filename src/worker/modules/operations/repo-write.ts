import { first, run, stmt } from '../../platform/db.ts';

const ACTIVE = `status IN ('queued', 'running', 'waiting')`;

export interface Written {
  status: string;
  cancel_requested: number;
}

/**
 * One step's element and the row's status, absolute values. The attempt guard stops an old attempt
 * writing over a retried operation; an ended row takes no write. Null: nothing written.
 */
export function writeStep(
  db: D1Database,
  w: {
    id: string;
    attempt: number;
    now: number;
    index: number;
    stepJson: string;
    stepKey: string;
    status: 'running' | 'waiting';
    leaseUntil: number;
  },
): Promise<Written | null> {
  // The index is an integer from the code's own step list, never a request value.
  const at = `$[${Math.trunc(w.index)}]`;
  return first<Written>(
    db,
    `UPDATE operations SET steps = json_set(steps, ?, json(?)), step_key = ?, status = ?,
       revision = revision + 1, started_at = COALESCE(started_at, ?), updated_at = ?, heartbeat_at = ?,
       lease_until = CASE WHEN lease_until > 0 THEN ? ELSE lease_until END
     WHERE id = ? AND attempt = ? AND ${ACTIVE}
     RETURNING status, cancel_requested`,
    [at, w.stepJson, w.stepKey, w.status, w.now, w.now, w.now, w.leaseUntil, w.id, w.attempt],
  );
}

/** Only the heartbeat and the lease: no revision bump, so an unchanged poll still gets its 304. */
export async function writeHeartbeat(
  db: D1Database,
  w: { id: string; attempt: number; now: number; leaseUntil: number },
): Promise<Written | null> {
  return first<Written>(
    db,
    `UPDATE operations SET heartbeat_at = ?,
       lease_until = CASE WHEN lease_until > 0 THEN ? ELSE lease_until END
     WHERE id = ? AND attempt = ? AND ${ACTIVE}
     RETURNING status, cancel_requested`,
    [w.now, w.leaseUntil, w.id, w.attempt],
  );
}

export function readCancelRequested(db: D1Database, id: string): Promise<number | null> {
  return first<{ cancel_requested: number }>(
    db,
    'SELECT cancel_requested FROM operations WHERE id = ?',
    [id],
  ).then((r) => r?.cancel_requested ?? null);
}

export interface Finish {
  id: string;
  attempt: number;
  now: number;
  status: 'succeeded' | 'failed' | 'cancelled';
  steps: string;
  stepKey: string | null;
  error: { code: string; step: string | null; retryable: boolean } | null;
  result: string | null;
  expiresAt: number | null;
}

/** The terminal write. A statement, so a domain batch can commit its own end state with it. */
export function finishStmt(db: D1Database, f: Finish): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE operations SET status = ?, steps = ?, step_key = ?, error_code = ?, error_step = ?,
       error_retryable = ?, result = ?, revision = revision + 1, started_at = COALESCE(started_at, ?),
       updated_at = ?, finished_at = ?, expires_at = COALESCE(?, expires_at), lease_until = NULL
     WHERE id = ? AND attempt = ? AND ${ACTIVE}`,
    [
      f.status,
      f.steps,
      f.stepKey,
      f.error?.code ?? null,
      f.error?.step ?? null,
      f.error === null ? null : f.error.retryable ? 1 : 0,
      f.result,
      f.now,
      f.now,
      f.now,
      f.expiresAt,
      f.id,
      f.attempt,
    ],
  );
}

export async function finish(db: D1Database, f: Finish): Promise<boolean> {
  return ((await finishStmt(db, f).run()).meta.changes ?? 0) === 1;
}

/** A stop of a queued operation, or the flag a running one's runner reads at its next boundary. */
export async function markCancel(
  db: D1Database,
  id: string,
  now: number,
): Promise<{ changes: number }> {
  return run(
    db,
    `UPDATE operations SET cancel_requested = 1, revision = revision + 1, updated_at = ?
     WHERE id = ? AND status IN ('running', 'waiting') AND cancel_requested = 0`,
    [now, id],
  );
}

/** A failed operation goes back to the start of its failed step with the next attempt. */
export async function resetForRetry(
  db: D1Database,
  r: {
    id: string;
    attempt: number;
    now: number;
    steps: string;
    stepKey: string | null;
    retryKey: string | null;
  },
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE operations SET status = 'queued', attempt = attempt + 1, steps = ?, step_key = ?,
       error_code = NULL, error_step = NULL, error_retryable = NULL, result = NULL, finished_at = NULL,
       expires_at = NULL, cancel_requested = 0, lease_until = NULL, heartbeat_at = ?, retry_key = ?,
       revision = revision + 1, updated_at = ?
     WHERE id = ? AND attempt = ? AND status = 'failed' AND error_retryable = 1`,
    [r.steps, r.stepKey, r.now, r.retryKey, r.now, r.id, r.attempt],
  );
  return changes === 1;
}
