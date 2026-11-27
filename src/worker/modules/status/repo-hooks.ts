import { all, run, stmt } from '../../platform/db.ts';

/** The cron schedule a hook runs on, or the queue. */
export type HookKind = 'minute' | 'daily' | 'queue';

export interface HookHealthRow {
  kind: HookKind;
  hook: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_code: string | null;
}

/** Sets the success or failure side that is given; the other side keeps its value. */
export function hookHealthStmt(
  db: D1Database,
  kind: HookKind,
  hook: string,
  successAt: number | null,
  failureAt: number | null,
  failureCode: string | null,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO hook_health (kind, hook, last_success_at, last_failure_at, last_failure_code)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, hook) DO UPDATE SET
       last_success_at = COALESCE(excluded.last_success_at, last_success_at),
       last_failure_at = COALESCE(excluded.last_failure_at, last_failure_at),
       last_failure_code = COALESCE(excluded.last_failure_code, last_failure_code)`,
    [kind, hook, successAt, failureAt, failureCode],
  );
}

export function listHookHealth(db: D1Database): Promise<HookHealthRow[]> {
  return all<HookHealthRow>(
    db,
    'SELECT kind, hook, last_success_at, last_failure_at, last_failure_code FROM hook_health ORDER BY kind, hook',
  );
}

export interface DlqOutcome {
  messageId: string;
  jobKind: string;
  orgId: string | null;
  targetId: string | null;
  code: string;
  at: number;
}

/** A drop counts in Status, and is kept, this long. */
export const DLQ_KEEP_MS = 30 * 86_400_000;

/** One row per dropped message; a redelivery changes nothing. */
export async function recordDlqOutcome(db: D1Database, o: DlqOutcome): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO dlq_outcomes (message_id, job_kind, org_id, target_id, code, dropped_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [o.messageId, o.jobKind, o.orgId, o.targetId, o.code, o.at],
  );
}

export async function pruneDlqOutcomes(db: D1Database, now: number): Promise<void> {
  await run(db, 'DELETE FROM dlq_outcomes WHERE dropped_at < ?', [now - DLQ_KEEP_MS]);
}
