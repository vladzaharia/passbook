import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { coalesceTo, maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { all, stmt } from '../../platform/db.ts';

type Db = D1Database;

export interface ScanStaffRow {
  id: string;
  orgId: string;
  name: string;
  role: ScanRole;
  pinHash: string;
  disabledAt: number | null;
  updatedAt: number;
  /** Trigger-owned; read in the same row as the PIN hash and role (non-enumerable). */
  authEpoch?: number;
}

export interface StaffRaw {
  id: string;
  org_id: string;
  name: string;
  role: ScanRole;
  pin_hash: string;
  disabled_at: number | null;
  updated_at: number;
  auth_epoch: number;
}

export const toStaff = (r: StaffRaw): ScanStaffRow =>
  Object.defineProperty(
    {
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      role: r.role,
      pinHash: r.pin_hash,
      updatedAt: r.updated_at,
      disabledAt: r.disabled_at,
    } satisfies ScanStaffRow,
    'authEpoch',
    { value: r.auth_epoch, enumerable: false },
  ) as ScanStaffRow;

const COLUMNS = 'id, org_id, name, role, pin_hash, disabled_at, updated_at, auth_epoch';

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

export interface NewStaff {
  id: string;
  name: string;
  role: ScanRole;
  pinHash: string;
  createdBy: string;
  now: number;
}

/** org_id comes from the grant row. */
export const addStaffInsert = (g: Grant, row: NewStaff): GrantedStatement =>
  g.insertSelect(
    'scan_staff',
    ['id', 'name', 'role', 'pin_hash', 'pin_set_at', 'created_by', 'created_at', 'updated_at'],
    [row.id, row.name, row.role, row.pinHash, row.now, row.createdBy, row.now, row.now],
  );

/** Only the fields the edit names move; disabling keeps the first disable time. */
export function addStaffUpdate(
  g: Grant,
  id: string,
  input: { name?: string | undefined; role?: ScanRole | undefined; disabled?: boolean | undefined },
  now: number,
): GrantedStatement {
  const set: Record<string, SetValue> = { updated_at: maxNow(now) };
  if (input.name !== undefined) set.name = input.name;
  if (input.role !== undefined) set.role = input.role;
  if (input.disabled === true) set.disabled_at = coalesceTo(now);
  if (input.disabled === false) set.disabled_at = null;
  return g.update('scan_staff', { set, where: { id }, require: 'one' });
}

export const addStaffPinRotate = (
  g: Grant,
  id: string,
  pinHash: string,
  now: number,
): GrantedStatement =>
  g.update('scan_staff', {
    set: { pin_hash: pinHash, pin_set_at: now, updated_at: maxNow(now) },
    where: { id },
    require: 'one',
  });

/** A staff account spans modes, so disabling or rotating ends every same-org binding in the batch. */
export const addUnbindStaffEverywhere = (g: Grant, id: string, now: number): GrantedStatement =>
  g.update('scanners', {
    set: { staff_id: null, staff_since: null, staff_seen_at: null, updated_at: maxNow(now) },
    where: { staff_id: id },
  });

export interface StaffBase {
  id: string;
  orgId: string;
  name: string;
  role: ScanRole;
  pinSetAt: number;
  disabledAt: number | null;
}

/** The account itself, with no activity: what a mutation answers when the activity read is unavailable. */
export async function getStaffBase(db: Db, orgId: string, id: string): Promise<StaffBase | null> {
  const r = await stmt(
    db,
    'SELECT id, org_id, name, role, pin_set_at, disabled_at FROM scan_staff WHERE id = ? AND org_id = ?',
    [id, orgId],
  ).first<{
    id: string;
    org_id: string;
    name: string;
    role: ScanRole;
    pin_set_at: number;
    disabled_at: number | null;
  }>();
  return r
    ? {
        id: r.id,
        orgId: r.org_id,
        name: r.name,
        role: r.role,
        pinSetAt: r.pin_set_at,
        disabledAt: r.disabled_at,
      }
    : null;
}
