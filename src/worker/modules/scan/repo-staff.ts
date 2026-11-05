import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { all, first } from '../../platform/db.ts';

type Db = D1Database;

export interface ScanStaffRow {
  id: string;
  orgId: string;
  name: string;
  role: ScanRole;
  pinHash: string;
  disabledAt: number | null;
}

interface Raw {
  id: string;
  org_id: string;
  name: string;
  role: ScanRole;
  pin_hash: string;
  disabled_at: number | null;
}

const toRow = (r: Raw): ScanStaffRow => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  role: r.role,
  pinHash: r.pin_hash,
  disabledAt: r.disabled_at,
});

const COLUMNS = 'id, org_id, name, role, pin_hash, disabled_at';

/** Scoped to the org: another org's staff id is the same as an unknown one. */
export async function getStaff(db: Db, orgId: string, id: string): Promise<ScanStaffRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scan_staff WHERE id = ? AND org_id = ?`,
    [id, orgId],
  );
  return row ? toRow(row) : null;
}

export async function listActiveManagers(db: Db, orgId: string): Promise<ScanStaffRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scan_staff
     WHERE org_id = ? AND role = 'manager' AND disabled_at IS NULL ORDER BY name COLLATE NOCASE`,
    [orgId],
  );
  return rows.map(toRow);
}
