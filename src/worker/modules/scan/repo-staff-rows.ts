import type { z } from 'zod';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import { STAFF_PAGE_MAX } from './repo-staff-page.ts';

type StaffDto = z.infer<typeof ScanStaffSchema>;

export interface AdminStaffRaw {
  auth_ok: number;
  snapshot_ok: number;
  id: string | null;
  org_id: string;
  name: string;
  role: ScanRole;
  pin_set_at: number;
  disabled_at: number | null;
  locked: number;
  today: number;
  last_at: number | null;
  last_scan_id: string | null;
  scanner_name: string | null;
}

export type AdminStaffResult = {
  authorized: boolean;
  snapshotCurrent: boolean;
  items: StaffDto[];
  hasMore: boolean;
};

/** Decode both standalone reads and the exact row selected inside a write batch. */
export function adminStaffRows(
  results: readonly D1Result[],
  fragmentScanIds: readonly string[],
  limit = STAFF_PAGE_MAX,
): AdminStaffResult {
  const none = { items: [], hasMore: false };
  if (results.length !== fragmentScanIds.length + 1)
    return { authorized: true, snapshotCurrent: false, ...none };
  const all = (results[0]?.results ?? []) as readonly AdminStaffRaw[];
  const rows = all.slice(0, limit);
  const scope = rows[0];
  if (scope?.auth_ok !== 1) return { authorized: false, snapshotCurrent: true, ...none };
  if (scope.snapshot_ok !== 1) return { authorized: true, snapshotCurrent: false, ...none };
  const verified = new Map<string, boolean>();
  for (const [index, scanId] of fragmentScanIds.entries()) {
    const checks = results[index + 1]?.results as
      | { scan_id: string; verified: number }[]
      | undefined;
    const check = checks?.[0];
    const matches =
      checks !== undefined &&
      checks.length === 1 &&
      check !== undefined &&
      check.scan_id === scanId &&
      check.verified === 1;
    verified.set(scanId, verified.get(scanId) !== false && matches);
  }
  return {
    authorized: true,
    snapshotCurrent: true,
    hasMore: all.length > limit,
    items: rows.flatMap((row) =>
      row.id === null
        ? []
        : [
            {
              id: row.id,
              orgId: row.org_id,
              name: row.name,
              role: row.role,
              pinSetAt: row.pin_set_at,
              locked: Boolean(row.locked),
              disabledAt: row.disabled_at,
              today: row.today,
              lastScan:
                row.last_at === null
                  ? null
                  : {
                      at: row.last_at,
                      scannerName:
                        row.last_scan_id !== null && verified.get(row.last_scan_id) === true
                          ? (row.scanner_name ?? 'Scanner')
                          : 'Scanner',
                    },
            },
          ],
    ),
  };
}
