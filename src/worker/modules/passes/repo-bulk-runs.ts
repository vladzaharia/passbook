import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';
import type { DeferredStarter } from './repo-bulk-principal.ts';

export type BulkRunState = 'queued' | 'running' | 'done' | 'stopped' | 'failed';
export const ACTIVE_STATES: readonly BulkRunState[] = ['queued', 'running'];

export interface BulkRunRecord {
  id: string;
  orgId: string;
  mode: Mode;
  action: 'void' | 'send_email' | 'remove';
  message: string | null;
  state: BulkRunState;
  total: number;
  /** Items already handled, in snapshot order: the run resumes here. */
  cursor: number;
  done: number;
  skipped: number;
  skippedBy: Record<string, number>;
  starter: DeferredStarter;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  code: string | null;
}

interface Row {
  id: string;
  org_id: string;
  mode: Mode;
  action: BulkRunRecord['action'];
  message: string | null;
  state: BulkRunState;
  total: number;
  cursor: number;
  done: number;
  skipped: number;
  skipped_by: string;
  starter: string;
  code: string | null;
  created_at: number;
  moved_at: number;
  finished_at: number | null;
  stop_requested: number;
}

const COLUMNS = `id, org_id, mode, action, message, state, total, cursor, done, skipped, skipped_by,
  starter, code, created_at, moved_at, finished_at, stop_requested`;

const toRecord = (r: Row): BulkRunRecord => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  action: r.action,
  message: r.message,
  state: r.state,
  total: r.total,
  cursor: r.cursor,
  done: r.done,
  skipped: r.skipped,
  skippedBy: JSON.parse(r.skipped_by) as Record<string, number>,
  starter: JSON.parse(r.starter) as DeferredStarter,
  createdAt: r.created_at,
  updatedAt: r.moved_at,
  finishedAt: r.finished_at,
  code: r.code,
});

export async function readRun(
  db: D1Database,
  id: string,
): Promise<(BulkRunRecord & { stopRequested: boolean }) | null> {
  const row = await first<Row>(db, `SELECT ${COLUMNS} FROM pass_bulk_runs WHERE id = ?`, [id]);
  return row ? { ...toRecord(row), stopRequested: row.stop_requested === 1 } : null;
}

export async function insertRun(db: D1Database, r: BulkRunRecord): Promise<void> {
  await run(
    db,
    `INSERT INTO pass_bulk_runs (id, org_id, mode, action, message, state, total, cursor, done, skipped,
       skipped_by, starter, code, created_at, moved_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '{}', ?, NULL, ?, ?, NULL)`,
    [
      r.id,
      r.orgId,
      r.mode,
      r.action,
      r.message,
      r.state,
      r.total,
      JSON.stringify(r.starter),
      r.createdAt,
      r.updatedAt,
    ],
  );
}

/** Saves progress; a run that already ended (swept, stopped) is never written again. */
export async function saveRun(db: D1Database, r: BulkRunRecord): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE pass_bulk_runs SET state = ?, cursor = ?, done = ?, skipped = ?, skipped_by = ?, code = ?,
       moved_at = ?, finished_at = ?
     WHERE id = ? AND state IN ('queued', 'running')`,
    [
      r.state,
      r.cursor,
      r.done,
      r.skipped,
      JSON.stringify(r.skippedBy),
      r.code,
      r.updatedAt,
      r.finishedAt,
      r.id,
    ],
  );
  return result.changes === 1;
}

/** Takes the org-and-mode lock; false while another run holds it (a lock older than `staleBefore` is taken over). */
export async function takeLock(
  db: D1Database,
  orgId: string,
  mode: Mode,
  runId: string,
  now: number,
  staleBefore: number,
): Promise<boolean> {
  const result = await run(
    db,
    `INSERT INTO pass_bulk_locks (org_id, mode, run_id, moved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id, mode) DO UPDATE SET run_id = excluded.run_id, moved_at = excluded.moved_at
     WHERE pass_bulk_locks.moved_at < ?`,
    [orgId, mode, runId, now, staleBefore],
  );
  return result.changes === 1;
}

export async function touchLock(
  db: D1Database,
  orgId: string,
  mode: Mode,
  runId: string,
  now: number,
): Promise<void> {
  await run(
    db,
    'UPDATE pass_bulk_locks SET moved_at = ? WHERE org_id = ? AND mode = ? AND run_id = ?',
    [now, orgId, mode, runId],
  );
}

export async function releaseLock(
  db: D1Database,
  orgId: string,
  mode: Mode,
  runId: string,
): Promise<void> {
  await run(db, 'DELETE FROM pass_bulk_locks WHERE org_id = ? AND mode = ? AND run_id = ?', [
    orgId,
    mode,
    runId,
  ]);
}

/** Only an active run takes a stop; false when it already ended. */
export async function requestStop(db: D1Database, id: string): Promise<boolean> {
  const result = await run(
    db,
    "UPDATE pass_bulk_runs SET stop_requested = 1 WHERE id = ? AND state IN ('queued', 'running')",
    [id],
  );
  return result.changes === 1;
}

/** Active runs that have not moved since `before`: the sweeper fails them. */
export async function stalledRuns(
  db: D1Database,
  before: number,
  limit: number,
): Promise<BulkRunRecord[]> {
  const rows = await all<Row>(
    db,
    `SELECT ${COLUMNS} FROM pass_bulk_runs WHERE state IN ('queued', 'running') AND moved_at < ?
     ORDER BY moved_at LIMIT ?`,
    [before, limit],
  );
  return rows.map(toRecord);
}

/** Retention: ended runs older than `before` are deleted. */
export async function deleteEndedBefore(db: D1Database, before: number): Promise<void> {
  await run(
    db,
    "DELETE FROM pass_bulk_runs WHERE state NOT IN ('queued', 'running') AND moved_at < ?",
    [before],
  );
}

/** Whether a live lock (touched since `staleBefore`) is held for the org and mode. */
export async function lockHeld(
  db: D1Database,
  orgId: string,
  mode: Mode,
  staleBefore: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      'SELECT 1 AS x FROM pass_bulk_locks WHERE org_id = ? AND mode = ? AND moved_at >= ?',
      [orgId, mode, staleBefore],
    )) !== null
  );
}

/** Whether the run still holds the org-and-mode lock (a takeover of a stale one moves it to another run). */
export async function holdsLock(
  db: D1Database,
  orgId: string,
  mode: Mode,
  runId: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      'SELECT 1 AS x FROM pass_bulk_locks WHERE org_id = ? AND mode = ? AND run_id = ?',
      [orgId, mode, runId],
    )) !== null
  );
}

/** The stop flag, read before every pass. */
export async function stopFlag(db: D1Database, id: string): Promise<boolean> {
  const row = await first<{ s: number }>(
    db,
    'SELECT stop_requested AS s FROM pass_bulk_runs WHERE id = ?',
    [id],
  );
  return row?.s === 1;
}

/** The newest run of an organization and mode. */
export async function latestRun(
  db: D1Database,
  orgId: string,
  mode: Mode,
): Promise<(BulkRunRecord & { stopRequested: boolean }) | null> {
  const row = await first<Row>(
    db,
    `SELECT ${COLUMNS} FROM pass_bulk_runs WHERE org_id = ? AND mode = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [orgId, mode],
  );
  return row ? { ...toRecord(row), stopRequested: row.stop_requested === 1 } : null;
}

/**
 * Whether a bulk run already queued this pass's mail. The outbox row is written in the same batch as the
 * mail, so it is the marker: a step retried after a crash between the queueing and the cursor save finds
 * the row and counts the pass done instead of mailing again.
 */
export async function mailQueuedForRun(
  db: D1Database,
  passId: string,
  runId: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      "SELECT 1 AS x FROM outbox WHERE pass_id = ? AND kind = 'email' AND json_extract(payload, '$.runId') = ?",
      [passId, runId],
    )) !== null
  );
}
