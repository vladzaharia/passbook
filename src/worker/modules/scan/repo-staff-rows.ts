import type { z } from 'zod';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import type { HistoryRaw } from './history-row.ts';

type StaffDto = z.infer<typeof ScanStaffSchema>;

/** One row of the staff activity statement: the person, and the history of their latest scan. */
export type StaffActivityRaw = HistoryRaw & {
  auth_ok: number;
  snapshot_ok: number;
  m_id: string | null;
  m_org_id: string;
  m_name: string;
  m_role: ScanRole;
  m_pin_set_at: number;
  m_pin_reset: number;
  m_day_locked: number;
  m_disabled_at: number | null;
  m_locked: number;
  m_today: number;
};

export type AdminStaffResult = {
  authorized: boolean;
  snapshotCurrent: boolean;
  items: StaffDto[];
  hasMore: boolean;
};

export const noStaff = (authorized: boolean, snapshotCurrent: boolean): AdminStaffResult => ({
  authorized,
  snapshotCurrent,
  items: [],
  hasMore: false,
});

/** The person and their latest scan; `scannerName` is the name the viewer may see, or 'Scanner'. */
export function staffItem(row: StaffActivityRaw, scannerName: string | null): StaffDto | null {
  if (row.m_id === null) return null;
  return {
    id: row.m_id,
    orgId: row.m_org_id,
    name: row.m_name,
    role: row.m_role,
    pinSetAt: row.m_pin_set_at,
    pinResetRequired: row.m_pin_reset === 1,
    pinLockedToday: row.m_day_locked === 1,
    locked: Boolean(row.m_locked),
    disabledAt: row.m_disabled_at,
    today: row.m_today,
    lastScan: row.id === null ? null : { at: row.at, scannerName: scannerName ?? 'Scanner' },
  };
}
