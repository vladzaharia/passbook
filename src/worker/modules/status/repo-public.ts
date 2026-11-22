import { all, first, run } from '../../platform/db.ts';

export interface IncidentRow {
  id: string;
  title: string;
  note: string;
  component: 'api' | 'apple_push' | 'email' | 'webhooks' | 'google' | 'samsung' | null;
  impact: 'notice' | 'degraded' | 'outage';
  started_at: number;
  resolved_at: number | null;
}

export const incidents = (db: D1Database, since: number) =>
  all<IncidentRow>(
    db,
    `SELECT id, title, note, component, impact, started_at, resolved_at FROM status_incidents
     WHERE resolved_at IS NULL OR resolved_at >= ? ORDER BY started_at DESC LIMIT 20`,
    [since],
  );

export const getIncident = (db: D1Database, id: string) =>
  first<IncidentRow>(
    db,
    `SELECT id, title, note, component, impact, started_at, resolved_at FROM status_incidents WHERE id = ?`,
    [id],
  );

export const insertIncident = (
  db: D1Database,
  row: Omit<IncidentRow, 'resolved_at'> & { resolved_at?: null },
) =>
  run(
    db,
    `INSERT INTO status_incidents (id, title, note, component, impact, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.title, row.note, row.component, row.impact, row.started_at],
  );

/** Only an open note resolves, so a second resolve keeps the first time. Returns whether a row changed. */
export async function resolveIncidentRow(db: D1Database, id: string, at: number): Promise<boolean> {
  const res = await run(
    db,
    'UPDATE status_incidents SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
    [at, id],
  );
  return res.changes > 0;
}
