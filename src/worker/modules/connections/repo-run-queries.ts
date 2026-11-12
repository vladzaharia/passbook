import { all, first } from '../../platform/db.ts';

interface RunRow {
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
    `SELECT COUNT(*) AS n FROM passes p JOIN connections c
       ON c.id = p.connection_id AND c.org_id = p.org_id
     WHERE p.connection_id = ? AND p.mode = 'live' AND p.test_data_quarantined = 0`,
    [connectionId],
  );
  return { rows, passCount: passCount?.n ?? 0 };
}
