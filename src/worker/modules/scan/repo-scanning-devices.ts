import type { ScanningDevice, ScanSurface } from '../../../shared/contracts/scanning-sessions.ts';
import { all, first, stmt } from '../../platform/db.ts';

export interface ScanningDeviceRow {
  scanner_id: string;
  session_id: string;
  org_id: string;
  mode: 'live' | 'test';
  name: string;
  kind: 'device' | 'terminal' | 'display';
  surface: ScanningDevice['surface'];
  effective_surface: ScanSurface;
  overrides: string;
  capabilities: string | null;
  reported_at: number | null;
  admin_user_id: string | null;
  admin_name: string | null;
  token_hash: string | null;
  last_seen_at: number | null;
  revoked_at: number | null;
  settings: string;
  updated_at: number;
  device_key: string | null;
}
const SELECT = `SELECT d.*,s.name,s.kind,s.token_hash,s.last_seen_at,s.revoked_at,s.settings,s.updated_at,
  COALESCE(u.name,'Administrator') AS admin_name FROM scanning_devices d
  JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id
  LEFT JOIN users u ON u.id=d.admin_user_id`;
export const scanningDeviceRows = (db: D1Database, orgId: string, sessionId: string) =>
  all<ScanningDeviceRow>(
    db,
    `${SELECT} WHERE d.org_id=? AND d.session_id=? ORDER BY s.created_at,d.scanner_id`,
    [orgId, sessionId],
  );
export const scanningDeviceRow = (db: D1Database, orgId: string, scannerId: string) =>
  first<ScanningDeviceRow>(db, `${SELECT} WHERE d.org_id=? AND d.scanner_id=?`, [orgId, scannerId]);
export const adminScanningDevice = (
  db: D1Database,
  orgId: string,
  sessionId: string,
  userId: string,
  deviceKey: string,
) =>
  first<ScanningDeviceRow>(
    db,
    `${SELECT} WHERE d.org_id=? AND d.session_id=? AND d.admin_user_id=? AND d.device_key=? AND s.revoked_at IS NULL`,
    [orgId, sessionId, userId, deviceKey],
  );
export const insertScanningDeviceStmt = (
  db: D1Database,
  input: {
    id: string;
    sessionId: string;
    orgId: string;
    mode: string;
    surface: string;
    effectiveSurface: string;
    overrides: unknown;
    adminUserId?: string;
    deviceKey?: string;
  },
) =>
  stmt(
    db,
    `INSERT INTO scanning_devices(scanner_id,session_id,org_id,mode,surface,effective_surface,overrides,admin_user_id,device_key)
  VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      input.id,
      input.sessionId,
      input.orgId,
      input.mode,
      input.surface,
      input.effectiveSurface,
      JSON.stringify(input.overrides),
      input.adminUserId ?? null,
      input.deviceKey ?? null,
    ],
  );
export const updateScanningDeviceStmt = (
  db: D1Database,
  orgId: string,
  scannerId: string,
  surface: string,
  effective: string,
  overrides: unknown,
) =>
  stmt(
    db,
    'UPDATE scanning_devices SET surface=?,effective_surface=?,overrides=? WHERE scanner_id=? AND org_id=?',
    [surface, effective, JSON.stringify(overrides), scannerId, orgId],
  );
export const reportScanningDeviceStmt = (
  db: D1Database,
  orgId: string,
  scannerId: string,
  capabilities: unknown,
  now: number,
) =>
  stmt(
    db,
    'UPDATE scanning_devices SET capabilities=?,reported_at=? WHERE scanner_id=? AND org_id=?',
    [JSON.stringify(capabilities), now, scannerId, orgId],
  );
export const sessionWatchIds = async (db: D1Database, orgId: string, sessionId: string) =>
  (
    await all<{ id: string }>(
      db,
      `SELECT s.id FROM scanners s JOIN scanning_devices d ON d.scanner_id=s.id
    WHERE d.org_id=? AND d.session_id=? AND s.device_role='scan' AND s.revoked_at IS NULL`,
      [orgId, sessionId],
    )
  ).map((r) => r.id);
export const linkedDeviceRoleStmt = (
  db: D1Database,
  orgId: string,
  scannerId: string,
  role: string,
  now: number,
) =>
  stmt(
    db,
    `UPDATE scanners SET device_role=?,kind=CASE WHEN kind='display' AND ?='scan' THEN 'device' ELSE kind END,updated_at=? WHERE org_id=? AND id=?`,
    [role, role, now, orgId, scannerId],
  );

export const releaseAdminDeviceStmt = (db: D1Database, orgId: string, id: string) =>
  stmt(db, 'UPDATE scanning_devices SET device_key=NULL WHERE org_id=? AND scanner_id=?', [
    orgId,
    id,
  ]);
