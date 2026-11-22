import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { all } from '../../platform/db.ts';
import type { StaffBase } from './repo-staff.ts';
import { afterCursorSql, type StaffPage, staffNameMatch } from './repo-staff-page.ts';

/** An org's staff accounts in the list's order, with no activity: what a key reads. At most `limit` + 1 rows. */
export async function listStaffAccounts(
  db: D1Database,
  orgId: string,
  page: StaffPage,
): Promise<StaffBase[]> {
  const match = staffNameMatch(page.q);
  const after = afterCursorSql(page.cursor);
  const rows = await all<{
    id: string;
    org_id: string;
    name: string;
    role: ScanRole;
    pin_set_at: number;
    pin_reset_required: number;
    disabled_at: number | null;
  }>(
    db,
    `SELECT st.id, st.org_id, st.name, st.role, st.pin_set_at, st.pin_reset_required, st.disabled_at
     FROM scan_staff st WHERE st.org_id = ? AND ${match.sql} ${after.sql}
     ORDER BY (st.disabled_at IS NOT NULL), st.name COLLATE NOCASE, st.id LIMIT ?`,
    [orgId, ...match.params, ...after.params, page.limit + 1],
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    role: r.role,
    pinSetAt: r.pin_set_at,
    pinResetRequired: r.pin_reset_required === 1,
    disabledAt: r.disabled_at,
  }));
}
