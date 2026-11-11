import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScanWatchSchema } from '../../../shared/contracts/scan-setups.ts';
import type { Grant } from '../../platform/authority.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { all, chunk, first, placeholders } from '../../platform/db.ts';

export interface SetupMeta {
  scanner_id: string;
  session_id?: string | null;
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

/** Moving to another role ends a staff sign-in the old role allowed. */
export const addDeviceRole = (
  g: Grant,
  scannerId: string,
  currentRole: string,
  role: string,
  now: number,
) =>
  g.update('scanners', {
    set: {
      device_role: role,
      updated_at: maxNow(now),
      ...(currentRole === role ? {} : { staff_id: null, staff_since: null, staff_seen_at: null }),
    },
    where: { id: scannerId },
    require: 'one',
  });

export const addSetupAcceptsClear = (g: Grant, scannerId: string, now: number) =>
  g.update('scanners', {
    set: { event_id: null, updated_at: maxNow(now) },
    where: { id: scannerId },
    require: 'one',
  });

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
