import { all } from '../../platform/db.ts';

export const scanningSessionActivity = (
  db: D1Database,
  orgId: string,
  sessionId: string,
  mode: string,
) =>
  all<{
    id: string;
    at: number;
    deviceId: string;
    deviceName: string;
    passId: string | null;
    title: string | null;
    outcome: 'ok' | 'heads_up' | 'refused' | 'undone';
    direction: 'in' | 'out' | null;
  }>(
    db,
    `
    SELECT s.id,s.at,s.scanner_id AS deviceId,d.name AS deviceName,s.pass_id AS passId,p.display_title AS title,
      CASE WHEN s.undone_by IS NOT NULL THEN 'undone' ELSE s.outcome END AS outcome,s.direction
    FROM scans s JOIN scanning_devices a ON a.scanner_id=s.scanner_id JOIN scanners d ON d.id=a.scanner_id
    LEFT JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.deleted_at IS NULL
    WHERE a.org_id=? AND s.org_id=a.org_id AND a.session_id=? AND s.mode=? AND s.state='done' AND s.outcome IS NOT NULL
    ORDER BY s.at DESC,s.id DESC LIMIT 20`,
    [orgId, sessionId, mode],
  );
