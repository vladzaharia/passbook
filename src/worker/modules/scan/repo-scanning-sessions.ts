import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanningSession } from '../../../shared/contracts/scanning-sessions.ts';
import { all, first, stmt } from '../../platform/db.ts';

export interface ScanningSessionRow {
  id: string;
  org_id: string;
  org_name: string;
  mode: Mode;
  name: string;
  status: ScanningSession['status'];
  accepts: string | null;
  settings: string;
  time_zone: string;
  created_at: number;
  updated_at: number;
}
const SELECT = `SELECT s.*,o.name AS org_name FROM scanning_sessions s JOIN orgs o ON o.id=s.org_id`;
export const claimConfigRevisionStmt = (
  db: D1Database,
  kind: 'session' | 'device',
  id: string,
  revision: number,
) =>
  stmt(db, 'INSERT INTO scanning_config_revisions(kind,target_id,revision) VALUES(?,?,?)', [
    kind,
    id,
    revision,
  ]);

export const scanningSessionRow = (db: D1Database, orgId: string | null, id: string) =>
  first<ScanningSessionRow>(db, `${SELECT} WHERE s.id=? AND (? IS NULL OR s.org_id=?)`, [
    id,
    orgId,
    orgId,
  ]);
export const scanningSessionForDevice = (db: D1Database, orgId: string, scannerId: string) =>
  first<ScanningSessionRow>(
    db,
    `${SELECT} JOIN scanning_devices d ON d.session_id=s.id AND d.org_id=s.org_id
    WHERE d.scanner_id=? AND s.org_id=?`,
    [scannerId, orgId],
  );
export const listScanningSessionRows = (
  db: D1Database,
  mode: Mode,
  query: { orgId?: string; cursor?: string; limit: number },
) =>
  all<ScanningSessionRow>(
    db,
    `${SELECT} WHERE s.mode=? AND (? IS NULL OR s.org_id=?) AND (? IS NULL OR s.id<?)
    ORDER BY s.id DESC LIMIT ?`,
    [
      mode,
      query.orgId ?? null,
      query.orgId ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      query.limit + 1,
    ],
  );

export function insertScanningSessionStmt(
  db: D1Database,
  row: Omit<ScanningSessionRow, 'org_name'>,
  userId: string,
) {
  return stmt(
    db,
    `INSERT INTO scanning_sessions(id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.org_id,
      row.mode,
      row.name,
      row.status,
      row.accepts,
      row.settings,
      row.time_zone,
      row.created_at,
      row.updated_at,
      userId,
    ],
  );
}
export const updateScanningSessionStmt = (db: D1Database, row: ScanningSessionRow) =>
  stmt(
    db,
    `UPDATE scanning_sessions SET name=?,status=?,accepts=?,settings=?,time_zone=?,updated_at=? WHERE id=? AND org_id=?`,
    [
      row.name,
      row.status,
      row.accepts,
      row.settings,
      row.time_zone,
      row.updated_at,
      row.id,
      row.org_id,
    ],
  );
export const scanningSessionStats = (
  db: D1Database,
  orgId: string,
  sessionId: string,
  since: number,
  onlineSince: number,
) =>
  first<{ devices: number; online: number; today: number }>(
    db,
    `SELECT
    (SELECT count(*) FROM scanning_devices d JOIN scanners s ON s.id=d.scanner_id WHERE d.org_id=? AND d.session_id=? AND s.revoked_at IS NULL) AS devices,
    (SELECT count(*) FROM scanning_devices d JOIN scanners s ON s.id=d.scanner_id WHERE d.org_id=? AND d.session_id=? AND s.revoked_at IS NULL AND s.last_seen_at>=?) AS online,
    (SELECT count(*) FROM scans s JOIN scanning_devices d ON d.scanner_id=s.scanner_id WHERE d.org_id=? AND d.session_id=? AND s.mode=d.mode AND s.at>=? AND s.outcome='ok' AND s.action_kind!='undo' AND s.undone_by IS NULL) AS today`,
    [orgId, sessionId, orgId, sessionId, onlineSince, orgId, sessionId, since],
  );

export const scanningSessionTodayStmt = (
  db: D1Database,
  orgId: string,
  sessionId: string,
  mode: Mode,
  since: number,
) =>
  stmt(
    db,
    `SELECT count(*) AS n FROM scans s JOIN scanning_devices d ON d.scanner_id=s.scanner_id
    WHERE d.org_id=? AND d.session_id=? AND s.mode=? AND s.at>=? AND s.outcome='ok' AND s.action_kind!='undo' AND s.undone_by IS NULL`,
    [orgId, sessionId, mode, since],
  );
