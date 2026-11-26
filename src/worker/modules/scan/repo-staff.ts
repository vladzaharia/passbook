import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { coalesceTo, maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { stmt } from '../../platform/db.ts';

type Db = D1Database;

export interface ScanStaffRow {
  id: string;
  orgId: string;
  name: string;
  role: ScanRole;
  pinHash: string;
  pinSetAt: number;
  /** A shared PIN was seen: the person has not taken the new PIN the server set yet. */
  pinResetRequired: boolean;
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
  pin_set_at: number;
  pin_reset_required: number;
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
      pinSetAt: r.pin_set_at,
      pinResetRequired: r.pin_reset_required === 1,
      updatedAt: r.updated_at,
      disabledAt: r.disabled_at,
    } satisfies ScanStaffRow,
    'authEpoch',
    { value: r.auth_epoch, enumerable: false },
  ) as ScanStaffRow;

const COLUMNS =
  'id, org_id, name, role, pin_hash, pin_set_at, pin_reset_required, disabled_at, updated_at, auth_epoch';

export const staffStatement = (db: Db, orgId: string, id: string): D1PreparedStatement =>
  stmt(db, `SELECT ${COLUMNS} FROM scan_staff WHERE id = ? AND org_id = ?`, [id, orgId]);

/**
 * The active managers of an org, for a PIN that names none: a PIN is matched against these. A person
 * who has not taken the new PIN the server set is left out: their PIN is a plain miss.
 */
export const managerRosterStatement = (
  db: Db,
  orgId: string,
  deskOk = false,
): D1PreparedStatement =>
  stmt(
    db,
    `SELECT ${COLUMNS} FROM scan_staff WHERE org_id = ? AND role IN ('manager'${deskOk ? ",'desk'" : ''}) AND disabled_at IS NULL
       AND pin_reset_required = 0
     ORDER BY id`,
    [orgId],
  );

/**
 * Who a PIN alone can be: the one active person with its tag, and everyone whose tag is not set yet
 * (those from before tags, until their next sign-in), so a PIN shared with one of them is still seen.
 */
export const pinOnlyCandidatesStatement = (
  db: Db,
  orgId: string,
  tag: string,
): D1PreparedStatement =>
  stmt(
    db,
    `SELECT ${COLUMNS}, pin_tag = ? AS tag_hit FROM scan_staff
     WHERE org_id = ? AND disabled_at IS NULL AND (pin_tag = ? OR pin_tag IS NULL) ORDER BY id`,
    [tag, orgId, tag],
  );

/** Everyone ever added, disabled included: a new PIN must not equal one that re-enabling would bring back. */
export const fullRosterStatement = (db: Db, orgId: string): D1PreparedStatement =>
  stmt(db, `SELECT ${COLUMNS} FROM scan_staff WHERE org_id = ? ORDER BY id`, [orgId]);

/** The named person, or every active manager when the PIN names none; one who must take a new PIN is no one. */
export const approverStatement = (
  db: Db,
  orgId: string,
  staffId: string | undefined,
  deskOk = false,
) =>
  staffId
    ? stmt(
        db,
        `SELECT ${COLUMNS} FROM scan_staff WHERE id = ? AND org_id = ? AND pin_reset_required = 0`,
        [staffId, orgId],
      )
    : managerRosterStatement(db, orgId, deskOk);

/** The approvers a request reads: with `alone` the whole roster (never the named person), else as named. */
export const approverForRequest = (
  db: Db,
  orgId: string,
  approval: { staffId?: string | undefined; alone?: boolean | undefined },
  deskOk: boolean,
) => approverStatement(db, orgId, approval.alone ? undefined : approval.staffId, deskOk);

/** Scoped to the org: another org's staff id is the same as an unknown one. */
export async function getStaff(db: Db, orgId: string, id: string): Promise<ScanStaffRow | null> {
  const row = await staffStatement(db, orgId, id).first<StaffRaw>();
  return row ? toStaff(row) : null;
}

export interface NewStaff {
  id: string;
  name: string;
  role: ScanRole;
  pinHash: string;
  pinTag: string;
  /** The MAC root the hash was made under. */
  pinMacVersion: number;
  createdBy: string | null;
  now: number;
}

/** org_id comes from the grant row. */
export const addStaffInsert = (g: Grant, row: NewStaff): GrantedStatement =>
  g.insertSelect(
    'scan_staff',
    [
      'id',
      'name',
      'role',
      'pin_hash',
      'pin_tag',
      'pin_mac_version',
      'pin_set_at',
      'created_by',
      'created_at',
      'updated_at',
    ],
    [
      row.id,
      row.name,
      row.role,
      row.pinHash,
      row.pinTag,
      row.pinMacVersion,
      row.now,
      row.createdBy,
      row.now,
      row.now,
    ],
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
  pinTag: string,
  pinMacVersion: number,
  now: number,
): GrantedStatement =>
  g.update('scan_staff', {
    set: {
      pin_hash: pinHash,
      pin_tag: pinTag,
      pin_reset_required: 0,
      pin_mac_version: pinMacVersion,
      pin_set_at: now,
      updated_at: maxNow(now),
    },
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
  pinResetRequired: boolean;
  disabledAt: number | null;
}

/** The account itself, with no activity: what a mutation answers when the activity read is unavailable. */
export async function getStaffBase(db: Db, orgId: string, id: string): Promise<StaffBase | null> {
  const r = await stmt(
    db,
    'SELECT id, org_id, name, role, pin_set_at, pin_reset_required, disabled_at FROM scan_staff WHERE id = ? AND org_id = ?',
    [id, orgId],
  ).first<{
    id: string;
    org_id: string;
    name: string;
    role: ScanRole;
    pin_set_at: number;
    pin_reset_required: number;
    disabled_at: number | null;
  }>();
  return r
    ? {
        id: r.id,
        orgId: r.org_id,
        name: r.name,
        role: r.role,
        pinSetAt: r.pin_set_at,
        pinResetRequired: r.pin_reset_required === 1,
        disabledAt: r.disabled_at,
      }
    : null;
}

/** No other active approver of the same roles exists at commit: a colleague added since the read voids it. */
export const onlyApproverCheck = (orgId: string, approverId: string, deskOk: boolean): Check => ({
  reason: 'staff',
  ok: (b) => `NOT EXISTS (SELECT 1 FROM scan_staff o WHERE o.org_id = ${b.bind(orgId)}
    AND o.id != ${b.bind(approverId)} AND o.role IN ('manager'${deskOk ? ",'desk'" : ''})
    AND o.disabled_at IS NULL AND o.pin_reset_required = 0)`,
});
