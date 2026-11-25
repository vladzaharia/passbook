import { all, first, run } from '../../platform/db.ts';
import type { Target } from './types.ts';

/** `passbook`: PassBook added it (a live grant in the binding). `external`: found in Polaris ID without a grant. */
export type Presence = 'none' | 'passbook' | 'external';

export interface TargetStateRow {
  subject: string;
  target: Target;
  user_id: string | null;
  observed: 0 | 1 | null;
  presence: Presence;
  held_at: number | null;
  applied_at: number | null;
  observed_at: number | null;
  error_code: string | null;
}

const COLUMNS =
  'subject, target, user_id, observed, presence, held_at, applied_at, observed_at, error_code';

export const statesOfSubject = (db: D1Database, subject: string) =>
  all<TargetStateRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_target_state WHERE subject = ? ORDER BY target`,
    [subject],
  );

export const statesOfUser = (db: D1Database, userId: string) =>
  all<TargetStateRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_target_state WHERE user_id = ? ORDER BY subject, target`,
    [userId],
  );

export const stateOf = (db: D1Database, subject: string, target: Target) =>
  first<TargetStateRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_target_state WHERE subject = ? AND target = ?`,
    [subject, target],
  );

export interface Observation {
  subject: string;
  target: Target;
  userId: string | null;
  observed: boolean;
  presence: Presence;
  now: number;
}

/** What `lookup`, `snapshot` or an `apply` read back. Clears the last error and never touches a hold. */
export async function recordObserved(db: D1Database, o: Observation): Promise<void> {
  await run(
    db,
    `INSERT INTO idp_target_state (subject, target, user_id, observed, presence, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject, target) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, user_id), observed = excluded.observed,
       presence = excluded.presence, observed_at = excluded.observed_at, error_code = NULL`,
    [o.subject, o.target, o.userId, o.observed ? 1 : 0, o.presence, o.now],
  );
}

/** An `apply` that changed the target: the observation plus the time PassBook applied it. */
export async function recordApplied(db: D1Database, o: Observation): Promise<void> {
  await recordObserved(db, o);
  await run(db, 'UPDATE idp_target_state SET applied_at = ? WHERE subject = ? AND target = ?', [
    o.now,
    o.subject,
    o.target,
  ]);
}

/** The last failure for this target (a stable code, never a message). */
export async function recordError(
  db: D1Database,
  subject: string,
  target: Target,
  userId: string | null,
  code: string,
): Promise<void> {
  await run(
    db,
    `INSERT INTO idp_target_state (subject, target, user_id, error_code) VALUES (?, ?, ?, ?)
     ON CONFLICT (subject, target) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, user_id), error_code = excluded.error_code`,
    [subject, target, userId, code],
  );
}

/** The owner removed a role PassBook added: it is held, never re-added until Restore. Keeps the first time. */
export async function holdTarget(
  db: D1Database,
  subject: string,
  target: Target,
  userId: string | null,
  now: number,
): Promise<void> {
  await run(
    db,
    `INSERT INTO idp_target_state (subject, target, user_id, observed, presence, held_at, observed_at)
     VALUES (?, ?, ?, 0, 'none', ?, ?)
     ON CONFLICT (subject, target) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, user_id), held_at = COALESCE(held_at, excluded.held_at),
       observed = 0, presence = 'none', observed_at = excluded.observed_at`,
    [subject, target, userId, now, now],
  );
}

/** Restore: clears the hold. True when there was one. */
export async function clearHold(db: D1Database, subject: string, target: Target): Promise<boolean> {
  return (
    (
      await run(
        db,
        'UPDATE idp_target_state SET held_at = NULL WHERE subject = ? AND target = ? AND held_at IS NOT NULL',
        [subject, target],
      )
    ).changes > 0
  );
}

export async function heldTargets(db: D1Database, subject: string): Promise<Set<Target>> {
  const rows = await all<{ target: Target }>(
    db,
    'SELECT target FROM idp_target_state WHERE subject = ? AND held_at IS NOT NULL',
    [subject],
  );
  return new Set(rows.map((r) => r.target));
}

export interface TargetCounts {
  target: Target;
  observed: number;
  passbook: number;
  external: number;
  held: number;
}

/** Per target: how many subjects were seen holding it, by who added it, and how many are held. */
export const countsByTarget = (db: D1Database) =>
  all<TargetCounts>(
    db,
    `SELECT target,
       coalesce(sum(observed = 1), 0) AS observed,
       coalesce(sum(observed = 1 AND presence = 'passbook'), 0) AS passbook,
       coalesce(sum(observed = 1 AND presence = 'external'), 0) AS external,
       coalesce(sum(held_at IS NOT NULL), 0) AS held
     FROM idp_target_state GROUP BY target ORDER BY target`,
  );

/** Subjects whose last drain failed, for the Differences list and the health count. */
export const failedStates = (db: D1Database, limit: number) =>
  all<TargetStateRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_target_state WHERE error_code IS NOT NULL ORDER BY subject, target LIMIT ?`,
    [limit],
  );
