import { all, first, stmt } from '../../platform/db.ts';

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

/** The admin list: every open note first (an old one must stay resolvable), then the recent resolved ones. */
export const adminIncidents = (db: D1Database, since: number) =>
  all<IncidentRow>(
    db,
    `SELECT id, title, note, component, impact, started_at, resolved_at FROM status_incidents
     WHERE resolved_at IS NULL OR resolved_at >= ?
     ORDER BY resolved_at IS NULL DESC, started_at DESC LIMIT 100`,
    [since],
  );

export const insertIncidentStmt = (db: D1Database, row: Omit<IncidentRow, 'resolved_at'>) =>
  stmt(
    db,
    `INSERT INTO status_incidents (id, title, note, component, impact, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.title, row.note, row.component, row.impact, row.started_at],
  );

/** Only an open note resolves, so a second resolve keeps the first time and changes no row. */
export const resolveIncidentStmt = (db: D1Database, id: string, at: number) =>
  stmt(db, 'UPDATE status_incidents SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', [
    at,
    id,
  ]);
