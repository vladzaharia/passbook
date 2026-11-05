import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { all, stmt } from '../../platform/db.ts';

type Db = D1Database;

export interface ScanStaffRow {
  id: string;
  orgId: string;
  name: string;
  role: ScanRole;
  pinHash: string;
  disabledAt: number | null;
}

export interface StaffRaw {
  id: string;
  org_id: string;
  name: string;
  role: ScanRole;
  pin_hash: string;
  disabled_at: number | null;
}

export const toStaff = (r: StaffRaw): ScanStaffRow => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  role: r.role,
  pinHash: r.pin_hash,
  disabledAt: r.disabled_at,
});

const COLUMNS = 'id, org_id, name, role, pin_hash, disabled_at';

export const staffStatement = (db: Db, orgId: string, id: string): D1PreparedStatement =>
  stmt(db, `SELECT ${COLUMNS} FROM scan_staff WHERE id = ? AND org_id = ?`, [id, orgId]);

/** Scoped to the org: another org's staff id is the same as an unknown one. */
export async function getStaff(db: Db, orgId: string, id: string): Promise<ScanStaffRow | null> {
  const row = await staffStatement(db, orgId, id).first<StaffRaw>();
  return row ? toStaff(row) : null;
}

export async function listActiveManagers(db: Db, orgId: string): Promise<ScanStaffRow[]> {
  const rows = await all<StaffRaw>(
    db,
    `SELECT ${COLUMNS} FROM scan_staff
     WHERE org_id = ? AND role = 'manager' AND disabled_at IS NULL ORDER BY name COLLATE NOCASE`,
    [orgId],
  );
  return rows.map(toStaff);
}
