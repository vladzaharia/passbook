import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScanWatchSchema } from '../../../shared/contracts/scan-setups.ts';
import { all, chunk, first, placeholders, stmt } from '../../platform/db.ts';

export interface SetupMeta {
  scanner_id: string;
  session_id?: string;
  admin_session: number;
  admin_user_id: string | null;
  admin_name: string | null;
  watch: string | null;
}
export async function setupMetas(db: D1Database, orgId: string | null, ids: string[]) {
  const pages = await Promise.all(
    chunk(ids, 90).map((part) =>
      all<SetupMeta>(
        db,
        `SELECT m.*,(SELECT d.session_id FROM scanning_devices d WHERE d.scanner_id=m.scanner_id AND d.org_id=m.org_id) AS session_id,COALESCE(u.name,u.primary_email) AS admin_name FROM scanner_setups m
    LEFT JOIN users u ON u.id=m.admin_user_id WHERE (? IS NULL OR m.org_id=?)
    AND m.scanner_id IN (${placeholders(part.length)})`,
        [orgId, orgId, ...part],
      ),
    ),
  );
  return pages.flat();
}

export const setupMeta = (db: D1Database, orgId: string, scannerId: string) =>
  first<SetupMeta>(
    db,
    `SELECT m.*,(SELECT d.session_id FROM scanning_devices d WHERE d.scanner_id=m.scanner_id AND d.org_id=m.org_id) AS session_id,COALESCE(u.name,u.primary_email) AS admin_name FROM scanner_setups m
    LEFT JOIN users u ON u.id=m.admin_user_id WHERE m.org_id=? AND m.scanner_id=?`,
    [orgId, scannerId],
  );

export const adminSetupId = async (db: D1Database, orgId: string, mode: Mode, userId: string) =>
  (
    await first<{ scanner_id: string }>(
      db,
      `SELECT m.scanner_id FROM scanner_setups m JOIN scanners s ON s.id=m.scanner_id
    WHERE m.org_id=? AND m.mode=? AND m.admin_user_id=? AND s.revoked_at IS NULL`,
      [orgId, mode, userId],
    )
  )?.scanner_id ?? null;

export const insertSetupStmt = (
  db: D1Database,
  scannerId: string,
  orgId: string,
  mode: Mode,
  userId: string | null,
  watch: unknown,
) =>
  stmt(
    db,
    'INSERT INTO scanner_setups(scanner_id,org_id,mode,admin_session,admin_user_id,watch) VALUES(?,?,?,?,?,?)',
    [scannerId, orgId, mode, userId ? 1 : 0, userId, watch ? JSON.stringify(watch) : null],
  );

export const setSetupWatchStmt = (
  db: D1Database,
  orgId: string,
  scannerId: string,
  watch: unknown,
) =>
  stmt(
    db,
    `INSERT INTO scanner_setups(scanner_id,org_id,mode,watch)
    SELECT id,org_id,mode,? FROM scanners WHERE org_id=? AND id=?
    ON CONFLICT(scanner_id) DO UPDATE SET watch=excluded.watch`,
    [watch ? JSON.stringify(watch) : null, orgId, scannerId],
  );

export const setDeviceRoleStmt = (
  db: D1Database,
  orgId: string,
  scannerId: string,
  role: string,
  now: number,
) =>
  stmt(
    db,
    `UPDATE scanners SET device_role=?,updated_at=?,
    staff_id=CASE WHEN device_role!=? THEN NULL ELSE staff_id END,
    staff_since=CASE WHEN device_role!=? THEN NULL ELSE staff_since END,
    staff_seen_at=CASE WHEN device_role!=? THEN NULL ELSE staff_seen_at END
    WHERE org_id=? AND id=?`,
    [role, now, role, role, role, orgId, scannerId],
  );

export const clearSetupAcceptsStmt = (db: D1Database, orgId: string, scannerId: string) =>
  stmt(db, 'UPDATE scanners SET event_id=NULL WHERE org_id=? AND id=?', [orgId, scannerId]);

export async function watchedScanners(db: D1Database, orgId: string, mode: Mode, ids: string[]) {
  if (!ids.length) return [];
  return all<{ id: string }>(
    db,
    `SELECT id FROM scanners WHERE org_id=? AND mode=? AND revoked_at IS NULL
    AND device_role='scan' AND id IN (${placeholders(ids.length)})`,
    [orgId, mode, ...ids],
  );
}

export function watchOf(meta: SetupMeta | null): z.infer<typeof ScanWatchSchema> | null {
  return meta?.watch ? ScanWatchSchema.parse(JSON.parse(meta.watch)) : null;
}
