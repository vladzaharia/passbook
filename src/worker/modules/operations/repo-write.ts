import {
  type OperationResult,
  OperationResultSchema,
} from '../../../shared/contracts/operations.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { WORKFLOW_WRITER, type Writer } from './progress-types.ts';

const ACTIVE = `status IN ('queued', 'running', 'waiting')`;

/** The lease condition of a write: a claimed lease refuses any other writer; a Workflow writer is fenced by attempt only. */
function fence(lease: Writer | null | undefined): { sql: string; params: string[] } {
  if (lease === WORKFLOW_WRITER) return { sql: '', params: [] };
  return { sql: ' AND (lease_owner IS NULL OR lease_owner = ?)', params: [lease ?? ''] };
}

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
    /** The lease token of the runner; a claimed lease refuses any other writer. */
    lease: Writer | null;
  },
): Promise<Written | null> {
  // The index is an integer from the code's own step list, never a request value.
  const at = `$[${Math.trunc(w.index)}]`;
  const old = (field: string) => `json_extract(steps, '${at}.${field}')`;
  // A runner holds the step as it loaded it, possibly seconds ago: `done` never goes down, and a wait never
  // ends sooner than one another job already set.
  const done = `CASE WHEN ${old('done')} IS NULL AND json_extract(?, '$.done') IS NULL THEN NULL
    ELSE MAX(COALESCE(${old('done')}, 0), COALESCE(json_extract(?, '$.done'), 0)) END`;
  const until = `CASE WHEN json_extract(?, '$.state') = 'waiting' AND ${old('until')} IS NOT NULL
    AND json_extract(?, '$.until') IS NOT NULL
    THEN MAX(${old('until')}, json_extract(?, '$.until')) ELSE json_extract(?, '$.until') END`;
  return first<Written>(
    db,
    `UPDATE operations SET steps = json_set(json_set(json_set(steps, ?, json(?)), '${at}.done', ${done}), '${at}.until', ${until}),
       step_key = ?, status = ?,
       revision = revision + 1, started_at = COALESCE(started_at, ?), updated_at = ?, heartbeat_at = ?,
       lease_until = CASE WHEN lease_until > 0 THEN ? ELSE lease_until END
     WHERE id = ? AND attempt = ? AND ${ACTIVE}${fence(w.lease).sql}
     RETURNING status, cancel_requested`,
    [
      at,
      w.stepJson,
      w.stepJson,
      w.stepJson,
      w.stepJson,
      w.stepJson,
      w.stepJson,
      w.stepJson,
      w.stepKey,
      w.status,
      w.now,
      w.now,
      w.now,
      w.leaseUntil,
      w.id,
      w.attempt,
      ...fence(w.lease).params,
    ],
  );
}

/**
 * One more done on a step, added by the database (capped at the step's total), with no change to its state or the
 * row's status: jobs that run side by side cannot know each other's count. Null: nothing written.
 */
export function incrementStep(
  db: D1Database,
  w: { id: string; attempt: number; now: number; index: number; lease: Writer | null },
): Promise<{ done: number; total: number | null } | null> {
  const at = `$[${Math.trunc(w.index)}]`;
  return first<{ done: number; total: number | null }>(
    db,
    `UPDATE operations SET steps = json_set(steps, '${at}.done',
         MIN(COALESCE(json_extract(steps, '${at}.total'), 9007199254740991),
             COALESCE(json_extract(steps, '${at}.done'), 0) + 1)),
       revision = revision + 1, updated_at = ?, heartbeat_at = ?
     WHERE id = ? AND attempt = ? AND ${ACTIVE}${fence(w.lease).sql}
     RETURNING json_extract(steps, '${at}.done') AS done, json_extract(steps, '${at}.total') AS total`,
    [w.now, w.now, w.id, w.attempt, ...fence(w.lease).params],
  );
}

/** Only the heartbeat and the lease: no revision bump, so an unchanged poll still gets its 304. */
export async function writeHeartbeat(
  db: D1Database,
  w: { id: string; attempt: number; now: number; leaseUntil: number; lease: Writer | null },
): Promise<Written | null> {
  return first<Written>(
    db,
    `UPDATE operations SET heartbeat_at = ?,
       lease_until = CASE WHEN lease_until > 0 THEN ? ELSE lease_until END
     WHERE id = ? AND attempt = ? AND ${ACTIVE}${fence(w.lease).sql}
     RETURNING status, cancel_requested`,
    [w.now, w.leaseUntil, w.id, w.attempt, ...fence(w.lease).params],
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
  result: OperationResult | null;
  expiresAt: number | null;
  /** The stop of an operation that has not started: refuses a row a runner already claimed (status or live lease). */
  onlyQueued?: true;
  /** A runner's lease token: a claimed lease refuses any other end write. Omit for the sweep and a stop. */
  lease?: Writer;
}

/** The terminal write. A statement, so a domain batch can commit its own end state with it. */
export function finishStmt(db: D1Database, f: Finish): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE operations SET status = ?, steps = ?, step_key = ?, error_code = ?, error_step = ?,
       error_retryable = ?, result = ?, revision = revision + 1, started_at = COALESCE(started_at, ?),
       updated_at = ?, finished_at = ?, expires_at = ${f.expiresAt === null ? 'expires_at' : '?'}, lease_until = NULL
     WHERE id = ? AND attempt = ? AND ${
       f.onlyQueued ? "status = 'queued' AND (lease_until IS NULL OR lease_until <= ?)" : ACTIVE
     }${f.lease === undefined ? '' : fence(f.lease).sql}`,
    [
      f.status,
      f.steps,
      f.stepKey,
      f.error?.code ?? null,
      f.error?.step ?? null,
      f.error === null ? null : f.error.retryable ? 1 : 0,
      f.result === null ? null : JSON.stringify(OperationResultSchema.parse(f.result)),
      f.now,
      f.now,
      f.now,
      ...(f.expiresAt === null ? [] : [f.expiresAt]),
      f.id,
      f.attempt,
      ...(f.onlyQueued ? [f.now] : []),
      ...(f.lease === undefined ? [] : fence(f.lease).params),
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
  attempt: number,
  now: number,
): Promise<{ changes: number }> {
  return run(
    db,
    `UPDATE operations SET cancel_requested = 1, revision = revision + 1, updated_at = ?
     WHERE id = ? AND attempt = ? AND status IN ('running', 'waiting') AND cancel_requested = 0`,
    [now, id, attempt],
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
    /** The row's owning session: the retrying one for a starter row (a step-up replaced the first), else unchanged. */
    actorSession: string | null;
    /** A starter operation keeps its 7 days from the retry; others get an expiry when they end. */
    expiresAt: number | null;
  },
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE operations SET status = 'queued', attempt = attempt + 1, steps = ?, step_key = ?,
       error_code = NULL, error_step = NULL, error_retryable = NULL, result = NULL, finished_at = NULL,
       workflow_instance_id = NULL,
       expires_at = ?, cancel_requested = 0, lease_until = NULL, lease_owner = NULL, resends = 0,
       heartbeat_at = ?, retry_key = ?, actor_session = ?,
       revision = revision + 1, updated_at = ?
     WHERE id = ? AND attempt = ? AND status = 'failed' AND error_retryable = 1`,
    [r.steps, r.stepKey, r.expiresAt, r.now, r.retryKey, r.actorSession, r.now, r.id, r.attempt],
  );
  return changes === 1;
}

/** Records the Workflow instance a retry started, for the stall sweep. Guarded by the attempt it belongs to. */
export async function setWorkflowInstance(
  db: D1Database,
  id: string,
  attempt: number,
  instanceId: string,
): Promise<void> {
  await run(db, 'UPDATE operations SET workflow_instance_id = ? WHERE id = ? AND attempt = ?', [
    instanceId,
    id,
    attempt,
  ]);
}
