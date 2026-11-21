import { first, run } from '../../platform/db.ts';

export type RunKind = 'provision' | 'rotate';
export type RunState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export interface RunRow {
  id: string;
  org_id: string | null;
  kind: RunKind;
  target_type: 'identity' | 'org' | 'wallet_credential';
  target_id: string;
  state: RunState;
  step: string | null;
  attempt: number;
  waiting_for: string | null;
  csr_pubkey_sha256: string | null;
  external_ref: string | null;
  error_code: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const COLUMNS = `id, org_id, kind, target_type, target_id, state, step, attempt, waiting_for,
  csr_pubkey_sha256, external_ref, error_code, created_by, created_at, updated_at, finished_at`;

export const OPEN_STATES = "('queued', 'running', 'waiting')";

export function getRun(
  db: D1Database,
  id: string,
  provider: 'apple' | 'google' = 'apple',
): Promise<RunRow | null> {
  return first<RunRow>(db, `SELECT ${COLUMNS} FROM identity_runs WHERE id = ? AND provider = ?`, [
    id,
    provider,
  ]);
}

export function findOpenRun(
  db: D1Database,
  targetType: RunRow['target_type'],
  targetId: string,
  kind: RunKind,
): Promise<RunRow | null> {
  return first<RunRow>(
    db,
    `SELECT ${COLUMNS} FROM identity_runs
     WHERE target_type = ? AND target_id = ? AND kind = ? AND state IN ${OPEN_STATES}`,
    [targetType, targetId, kind],
  );
}

export function latestRun(
  db: D1Database,
  targetType: RunRow['target_type'],
  targetId: string,
  kind: RunKind,
): Promise<RunRow | null> {
  return first<RunRow>(
    db,
    `SELECT ${COLUMNS} FROM identity_runs WHERE target_type = ? AND target_id = ? AND kind = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [targetType, targetId, kind],
  );
}

export interface NewRun {
  id: string;
  /** Default `apple`. */
  provider?: 'apple' | 'google';
  orgId: string | null;
  kind: RunKind;
  targetType: RunRow['target_type'];
  targetId: string;
  createdBy: string | null;
  ref: Record<string, unknown>;
  now: number;
}

/** False when an open run for the same target and kind already holds the unique index. */
export async function insertRun(db: D1Database, r: NewRun): Promise<boolean> {
  const { changes } = await run(
    db,
    `INSERT OR IGNORE INTO identity_runs
       (id, org_id, provider, kind, target_type, target_id, state, external_ref, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    [
      r.id,
      r.orgId,
      r.provider ?? 'apple',
      r.kind,
      r.targetType,
      r.targetId,
      JSON.stringify(r.ref),
      r.createdBy,
      r.now,
      r.now,
    ],
  );
  return changes === 1;
}

/** Enters a step. False when the run is no longer open (cancelled or finished elsewhere). */
export async function enterStep(db: D1Database, id: string, step: string, now: number) {
  const { changes } = await run(
    db,
    `UPDATE identity_runs SET step = ?, state = 'running', waiting_for = NULL, attempt = attempt + 1, updated_at = ?
     WHERE id = ? AND state IN ${OPEN_STATES}`,
    [step, now, id],
  );
  return changes === 1;
}

export async function parkRun(db: D1Database, id: string, waitingFor: string, now: number) {
  await run(
    db,
    `UPDATE identity_runs SET state = 'waiting', waiting_for = ?, updated_at = ?
     WHERE id = ? AND state IN ${OPEN_STATES}`,
    [waitingFor, now, id],
  );
}

/** Merges `patch` into the run's `external_ref` (RFC 7396), so a retried step never loses earlier facts. */
export async function patchRunRef(
  db: D1Database,
  id: string,
  patch: Record<string, unknown>,
  now: number,
  pubkeySha256?: string,
) {
  await run(
    db,
    `UPDATE identity_runs
     SET external_ref = json_patch(COALESCE(external_ref, '{}'), ?), updated_at = ?,
         csr_pubkey_sha256 = COALESCE(?, csr_pubkey_sha256)
     WHERE id = ?`,
    [JSON.stringify(patch), now, pubkeySha256 ?? null, id],
  );
}

export async function finishRun(
  db: D1Database,
  id: string,
  state: 'succeeded' | 'failed',
  errorCode: string | null,
  now: number,
) {
  await run(
    db,
    `UPDATE identity_runs SET state = ?, error_code = ?, waiting_for = NULL, updated_at = ?, finished_at = ?
     WHERE id = ? AND state IN ${OPEN_STATES}`,
    [state, errorCode, now, now, id],
  );
}

/** Which org holds a handle: undefined when free, null for a platform-reserved one. */
export async function handleOwner(
  db: D1Database,
  handle: string,
): Promise<{ orgId: string | null } | undefined> {
  const row = await first<{ org_id: string | null }>(
    db,
    'SELECT org_id FROM identity_handles WHERE handle = ?',
    [handle],
  );
  return row ? { orgId: row.org_id } : undefined;
}

export async function reserveHandleRow(db: D1Database, handle: string, orgId: string, now: number) {
  await run(
    db,
    'INSERT OR IGNORE INTO identity_handles (handle, org_id, reserved_at) VALUES (?, ?, ?)',
    [handle, orgId, now],
  );
}

/** The newest run that worked on this certificate row. */
export function runByCert(db: D1Database, certId: string) {
  return first<{ external_ref: string | null; csr_pubkey_sha256: string | null }>(
    db,
    `SELECT external_ref, csr_pubkey_sha256 FROM identity_runs
     WHERE json_extract(external_ref, '$.certId') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [certId],
  );
}
