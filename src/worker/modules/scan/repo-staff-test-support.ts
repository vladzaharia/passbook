import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { stmt } from '../../platform/db.ts';

/** Test-only: edits a staff row directly, bypassing grants, to stage a change made "elsewhere". */
export function updateStaffStmt(
  db: D1Database,
  orgId: string,
  id: string,
  input: { name?: string | undefined; role?: ScanRole | undefined; disabled?: boolean | undefined },
  now: number,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE scan_staff SET name = COALESCE(?, name), role = COALESCE(?, role),
       disabled_at = CASE ? WHEN 1 THEN COALESCE(disabled_at, ?) WHEN 0 THEN NULL ELSE disabled_at END,
       updated_at = MAX(updated_at + 1, ?)
     WHERE org_id = ? AND id = ?`,
    [input.name, input.role, input.disabled, now, now, orgId, id],
  );
}
