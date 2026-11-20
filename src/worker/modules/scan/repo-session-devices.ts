import type { ScanSurface } from '../../../shared/contracts/scanning-sessions.ts';
import { stmt } from '../../platform/db.ts';
import { scanAuthorizedStmt, withSessionRow } from './repo-read-authority.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import type { SessionReadAuthority } from './scanning-session-dto.ts';

export interface SessionDeviceRow {
  id: string;
  name: string;
  surface: ScanSurface;
  lastSeenAt: number | null;
}

/**
 * The live scan-role devices of one session, read in one batch with the viewer's fence and the
 * session row as it was read. Null when the fence no longer holds.
 */
export async function scanningSessionDevices(
  db: D1Database,
  row: ScanningSessionRow,
  authority: SessionReadAuthority,
  now: number,
): Promise<SessionDeviceRow[] | null> {
  if (
    !authority ||
    authority.orgId !== row.org_id ||
    authority.mode !== row.mode ||
    (authority.sessionId !== undefined && authority.sessionId !== row.id)
  )
    return null;
  const [authorized, devices] = await db.batch<{
    authorized?: number;
    id?: string;
    name?: string;
    surface?: ScanSurface;
    last_seen_at?: number | null;
  }>([
    scanAuthorizedStmt(db, withSessionRow(authority.at(now), row)),
    stmt(
      db,
      `SELECT device.id AS id, device.name AS name, d.effective_surface AS surface,
        device.last_seen_at AS last_seen_at
      FROM scanning_devices d
      JOIN scanning_sessions x ON x.id=d.session_id AND x.org_id=d.org_id AND x.mode=d.mode
      JOIN scanners device ON device.id=d.scanner_id AND device.org_id=d.org_id AND device.mode=d.mode
      WHERE x.id=? AND x.org_id=? AND x.mode=?
        AND device.device_role='scan' AND device.revoked_at IS NULL
      ORDER BY device.created_at, device.id LIMIT 50`,
      [row.id, row.org_id, row.mode],
    ),
  ]);
  if (authorized?.results?.[0]?.authorized !== 1) return null;
  return (devices?.results ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    surface: r.surface as ScanSurface,
    lastSeenAt: r.last_seen_at ?? null,
  }));
}
