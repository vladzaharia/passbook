import { first } from '../../platform/db.ts';

export interface Progress {
  done: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  skipped: number;
  notEmailed: number;
}

/** Counted from the rows, so a replayed step never counts a row twice. */
export async function progressOf(db: D1Database, importId: string): Promise<Progress> {
  const row = await first<Record<keyof Progress, number | null>>(
    db,
    `SELECT
       sum(action IN ('create', 'update') AND state IN ('done', 'failed')) AS done,
       sum(result = 'created') AS created,
       sum(result = 'updated') AS updated,
       sum(action = 'unchanged' OR result = 'unchanged') AS unchanged,
       sum(state = 'failed') AS failed,
       sum(state = 'skipped' AND action = 'create') AS skipped,
       sum(result = 'created' AND holder_email IS NOT NULL AND emailed = 0) AS notEmailed
     FROM pass_import_rows WHERE import_id = ?`,
    [importId],
  );
  return {
    done: row?.done ?? 0,
    created: row?.created ?? 0,
    updated: row?.updated ?? 0,
    unchanged: row?.unchanged ?? 0,
    failed: row?.failed ?? 0,
    skipped: row?.skipped ?? 0,
    notEmailed: row?.notEmailed ?? 0,
  };
}
