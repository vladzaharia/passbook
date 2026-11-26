import { first, run, stmt } from '../../platform/db.ts';

export interface OperationRow {
  id: string;
  kind: string;
  audience: 'org' | 'starter' | 'platform';
  org_id: string | null;
  mode: 'live' | 'test' | null;
  target_type: string | null;
  target_id: string | null;
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  steps: string;
  step_key: string | null;
  revision: number;
  attempt: number;
  cancel_requested: number;
  actor_type: 'user' | 'api_key' | 'system';
  actor_id: string | null;
  actor_session: string | null;
  dedupe_key: string | null;
  retry_key: string | null;
  workflow_instance_id: string | null;
  lease_until: number | null;
  lease_owner: string | null;
  resends: number;
  heartbeat_at: number | null;
  error_code: string | null;
  error_step: string | null;
  error_retryable: number | null;
  result: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  finished_at: number | null;
  expires_at: number | null;
}

export const COLUMNS = `id, kind, audience, org_id, mode, target_type, target_id, status, steps, step_key,
  revision, attempt, cancel_requested, actor_type, actor_id, actor_session, dedupe_key, retry_key, workflow_instance_id, lease_until, lease_owner, resends,
  heartbeat_at, error_code, error_step, error_retryable, result, created_at, started_at, updated_at,
  finished_at, expires_at`;

export interface NewOperationRow {
  id: string;
  kind: string;
  audience: OperationRow['audience'];
  orgId: string | null;
  mode: OperationRow['mode'];
  target: { type: string; id: string } | null;
  steps: string;
  actorType: OperationRow['actor_type'];
  actorId: string | null;
  actorSession: string | null;
  dedupeKey: string | null;
  workflowInstanceId: string | null;
  leaseUntil: number | null;
  now: number;
  expiresAt: number | null;
}

/** The INSERT as a statement, to batch with the domain row it describes. */
export function insertOperationStmt(db: D1Database, r: NewOperationRow): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO operations (id, kind, audience, org_id, mode, target_type, target_id, steps, actor_type,
       actor_id, actor_session, dedupe_key, workflow_instance_id, lease_until, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.kind,
      r.audience,
      r.orgId,
      r.mode,
      r.target?.type ?? null,
      r.target?.id ?? null,
      r.steps,
      r.actorType,
      r.actorId,
      r.actorSession,
      r.dedupeKey,
      r.workflowInstanceId,
      r.leaseUntil,
      r.now,
      r.now,
      r.expiresAt,
    ],
  );
}

/** A row by id, with no authority: only for the runner and sweeps. Reads for a caller go through repo-read.ts. */
export function rowById(db: D1Database, id: string): Promise<OperationRow | null> {
  return first<OperationRow>(db, `SELECT ${COLUMNS} FROM operations WHERE id = ?`, [id]);
}

export function activeByDedupe(db: D1Database, dedupeKey: string): Promise<OperationRow | null> {
  return first<OperationRow>(
    db,
    `SELECT ${COLUMNS} FROM operations
     WHERE dedupe_key = ? AND status IN ('queued', 'running', 'waiting')`,
    [dedupeKey],
  );
}

/** Claims the runner lease for `owner`: free or expired. Only the owner's writes extend it afterwards. */
export async function claimLease(
  db: D1Database,
  id: string,
  attempt: number,
  now: number,
  until: number,
  owner: string,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE operations SET lease_until = ?, lease_owner = ?, updated_at = ?
     WHERE id = ? AND attempt = ? AND status IN ('queued', 'running', 'waiting')
       AND (lease_until IS NULL OR lease_until <= ?)`,
    [until, owner, now, id, attempt, now],
  );
  return changes === 1;
}

/** The runner hands the operation on (a start over waits for its purge): the next `operation.run` can claim it. */
export async function releaseLease(
  db: D1Database,
  id: string,
  attempt: number,
  owner: string | null,
): Promise<void> {
  await run(
    db,
    `UPDATE operations SET lease_until = NULL, lease_owner = NULL
     WHERE id = ? AND attempt = ? AND status IN ('queued', 'running', 'waiting')
       AND (lease_owner IS NULL OR lease_owner = ?)`,
    [id, attempt, owner ?? ''],
  );
}
