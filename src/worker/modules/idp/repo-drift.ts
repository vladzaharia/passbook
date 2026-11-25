import { all, first, run } from '../../platform/db.ts';
import type { Target } from './types.ts';

export type DriftKind =
  | 'missing'
  | 'unexpected'
  | 'external_added'
  | 'owner_removed'
  | 'disabled_in_idp'
  | 'admin_changed'
  | 'unknown_member'
  | 'apply_failed';

export interface DriftRow {
  id: string;
  run_id: string;
  user_id: string | null;
  subject: string;
  target: Target;
  kind: DriftKind;
  found_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

const COLUMNS = 'id, run_id, user_id, subject, target, kind, found_at, resolved_at, resolution';

export interface NewDrift {
  id: string;
  runId: string;
  userId: string | null;
  subject: string;
  target: Target;
  kind: DriftKind;
  now: number;
}

/** The open difference of this kind for a subject and target, if one is already recorded. */
export const openDriftOf = (db: D1Database, subject: string, target: Target, kind: DriftKind) =>
  first<DriftRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_drift WHERE subject = ? AND target = ? AND kind = ? AND resolved_at IS NULL`,
    [subject, target, kind],
  );

/** Records a difference once: a repeat of an open one is a no-op. True when a row was written. */
export async function recordDrift(db: D1Database, d: NewDrift): Promise<boolean> {
  const result = await run(
    db,
    `INSERT INTO idp_drift (id, run_id, user_id, subject, target, kind, found_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM idp_drift WHERE subject = ? AND target = ? AND kind = ? AND resolved_at IS NULL)`,
    [d.id, d.runId, d.userId, d.subject, d.target, d.kind, d.now, d.subject, d.target, d.kind],
  );
  return result.changes > 0;
}

/** Closes an open difference with a short resolution (`applied`, `restored`, `gone`). True when one closed. */
export async function resolveDrift(
  db: D1Database,
  subject: string,
  target: Target,
  kind: DriftKind,
  resolution: string,
  now: number,
): Promise<boolean> {
  return (
    (
      await run(
        db,
        `UPDATE idp_drift SET resolved_at = ?, resolution = ?
         WHERE subject = ? AND target = ? AND kind = ? AND resolved_at IS NULL`,
        [now, resolution, subject, target, kind],
      )
    ).changes > 0
  );
}

export const openDrift = (db: D1Database, limit: number) =>
  all<DriftRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_drift WHERE resolved_at IS NULL ORDER BY found_at, id LIMIT ?`,
    [limit],
  );

export const openDriftOfSubject = (db: D1Database, subject: string) =>
  all<DriftRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_drift WHERE subject = ? AND resolved_at IS NULL ORDER BY found_at, id`,
    [subject],
  );

export const driftOfRun = (db: D1Database, runId: string) =>
  all<DriftRow>(db, `SELECT ${COLUMNS} FROM idp_drift WHERE run_id = ? ORDER BY found_at, id`, [
    runId,
  ]);

export const openDriftCounts = (db: D1Database) =>
  all<{ kind: DriftKind; n: number }>(
    db,
    'SELECT kind, count(*) AS n FROM idp_drift WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind',
  );
