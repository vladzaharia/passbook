import { all } from '../../platform/db.ts';

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
