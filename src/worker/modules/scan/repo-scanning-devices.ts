import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanningDevice, ScanSurface } from '../../../shared/contracts/scanning-sessions.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';

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
  JOIN scanning_sessions p ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
  JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id AND s.mode=d.mode
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
/** org_id and mode come from the grant row. */
export const addScanningDeviceInsert = (
  g: Grant,
  input: {
    id: string;
    sessionId: string;
    surface: string;
    effectiveSurface: string;
    overrides: unknown;
    adminUserId?: string | undefined;
    deviceKey?: string | undefined;
  },
): GrantedStatement =>
  g.insertSelect(
    'scanning_devices',
    [
      'scanner_id',
      'session_id',
      'surface',
      'effective_surface',
      'overrides',
      'admin_user_id',
      'device_key',
    ],
    [
      input.id,
      input.sessionId,
      input.surface,
      input.effectiveSurface,
      JSON.stringify(input.overrides),
      input.adminUserId ?? null,
      input.deviceKey ?? null,
    ],
  );
export const addScanningDeviceUpdate = (
  g: Grant,
  scannerId: string,
  surface: string,
  effective: string,
  overrides: unknown,
): GrantedStatement =>
  g.update('scanning_devices', {
    set: { surface, effective_surface: effective, overrides: JSON.stringify(overrides) },
    where: { scanner_id: scannerId },
    require: 'one',
  });
export const sessionWatchIds = async (
  db: D1Database,
  orgId: string,
  sessionId: string,
  mode: Mode,
) =>
  (
    await all<{ id: string }>(
      db,
      `SELECT s.id FROM scanning_devices d
      JOIN scanning_sessions p ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
      JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id AND s.mode=d.mode
      WHERE d.org_id=? AND d.session_id=? AND d.mode=? AND s.device_role='scan' AND s.revoked_at IS NULL`,
      [orgId, sessionId, mode],
    )
  ).map((r) => r.id);
/** Capabilities and the report time are volatile: they never move an epoch. */
export const reportedCapabilitiesStmt = (
  g: Grant,
  scannerId: string,
  capabilities: unknown,
  now: number,
): GrantedStatement =>
  g.update('scanning_devices', {
    set: { capabilities: JSON.stringify(capabilities), reported_at: now },
    where: { scanner_id: scannerId },
    require: 'one',
  });

/** A display that takes the scan role becomes a device; `kind` is the scanner's current kind. */
export const addLinkedDeviceRole = (
  g: Grant,
  scannerId: string,
  kind: string,
  role: string,
  now: number,
): GrantedStatement =>
  g.update('scanners', {
    set: {
      device_role: role,
      kind: kind === 'display' && role === 'scan' ? 'device' : kind,
      updated_at: maxNow(now),
    },
    where: { id: scannerId },
    require: 'one',
  });

/** A standalone scanner's device row follows its scanner to the new mode. */
export const addDeviceModeSync = (g: Grant, scannerId: string, mode: string): GrantedStatement =>
  g.update('scanning_devices', {
    set: { mode },
    where: { scanner_id: scannerId, session_id: scannerId },
  });

export const addAdminDeviceRelease = (g: Grant, scannerId: string): GrantedStatement =>
  g.update('scanning_devices', { set: { device_key: null }, where: { scanner_id: scannerId } });
