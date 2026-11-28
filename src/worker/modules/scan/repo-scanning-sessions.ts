import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanningSession } from '../../../shared/contracts/scanning-sessions.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { all, first, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { RACE_SESSION_PATCH } from './race-tags.ts';
import { scanLedgerCommonScopeSql, scanLedgerSuccessfulCandidateSql } from './repo-feed-scope.ts';
import { scanAuthorizedStmt, withSessionRow } from './repo-read-authority.ts';
import type { SessionReadAuthority } from './scanning-session-dto.ts';

export interface ScanningSessionRow {
  id: string;
  org_id: string;
  org_name: string;
  mode: Mode;
  name: string;
  status: ScanningSession['status'];
  accepts: string | null;
  settings: string;
  time_zone: string;
  /** Weekly schedule JSON; null: always open. */
  hours: string | null;
  /** Manual hold JSON. */
  hold: string | null;
  /** The cron's bookmark: the next instant the open state may change. Moves no epoch. */
  hours_next_at: number | null;
  created_at: number;
  updated_at: number;
  /** Trigger-owned; an edit derived from this row is checked against it at commit. */
  config_epoch: number;
  /** The template Scan passes made this session for; one live session per template. */
  setup_template_id?: string | null;
}
const SELECT = `SELECT s.*,o.name AS org_name FROM scanning_sessions s JOIN orgs o ON o.id=s.org_id`;

export const scanningSessionRow = (db: D1Database, orgId: string | null, id: string) =>
  first<ScanningSessionRow>(
    db,
    `${SELECT} WHERE s.id=?${orgId === null ? '' : ' AND s.org_id=?'}`,
    orgId === null ? [id] : [id, orgId],
  );
export const scanningSessionForDevice = (db: D1Database, orgId: string, scannerId: string) =>
  first<ScanningSessionRow>(
    db,
    `${SELECT} JOIN scanning_devices d ON d.session_id=s.id AND d.org_id=s.org_id AND d.mode=s.mode
    JOIN scanners device ON device.id=d.scanner_id AND device.org_id=d.org_id AND device.mode=d.mode
    WHERE d.scanner_id=? AND s.org_id=?`,
    [scannerId, orgId],
  );
/** Active sessions whose open state may have changed, by id after the cursor. */
export const dueHoursRows = (db: D1Database, now: number, limit: number, after: string | null) =>
  all<ScanningSessionRow>(
    db,
    `${SELECT} WHERE s.status='active' AND s.hours_next_at IS NOT NULL AND s.hours_next_at<=?
    ${after === null ? '' : 'AND s.id>?'} ORDER BY s.id LIMIT ?`,
    [now, ...(after === null ? [] : [after]), limit],
  );
export const listScanningSessionRows = (
  db: D1Database,
  mode: Mode,
  query: { orgId?: string; cursor?: string; limit: number },
) =>
  all<ScanningSessionRow>(
    db,
    `${SELECT} WHERE s.mode=?${query.orgId !== undefined ? ' AND s.org_id=?' : ''}${query.cursor !== undefined ? ' AND s.id<?' : ''}
    ORDER BY s.id DESC LIMIT ?`,
    [
      mode,
      ...(query.orgId !== undefined ? [query.orgId] : []),
      ...(query.cursor !== undefined ? [query.cursor] : []),
      query.limit + 1,
    ],
  );

/** org_id and mode come from the grant row. */
export const addScanningSessionInsert = (
  g: Grant,
  row: Omit<ScanningSessionRow, 'org_name' | 'org_id' | 'mode' | 'config_epoch' | 'hold'>,
  createdBy: string | null,
): GrantedStatement =>
  g.insertSelect(
    'scanning_sessions',
    [
      'id',
      'name',
      'status',
      'accepts',
      'settings',
      'time_zone',
      'hours',
      'hours_next_at',
      'created_at',
      'updated_at',
      'created_by',
      ...(row.setup_template_id ? ['setup_template_id'] : []),
    ],
    [
      row.id,
      row.name,
      row.status,
      row.accepts,
      row.settings,
      row.time_zone,
      row.hours,
      row.hours_next_at,
      row.created_at,
      row.updated_at,
      createdBy,
      ...(row.setup_template_id ? [row.setup_template_id] : []),
    ],
  );

/** Only the columns the edit names: a concurrent rename or status change survives. */
export function addScanningSessionUpdate(
  g: Grant,
  id: string,
  patch: Partial<
    Pick<
      ScanningSessionRow,
      | 'name'
      | 'status'
      | 'accepts'
      | 'settings'
      | 'time_zone'
      | 'hours'
      | 'hold'
      | 'hours_next_at'
      | 'setup_template_id'
    >
  >,
  now: number,
): GrantedStatement {
  const set: Record<string, SetValue> = { updated_at: maxNow(now) };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) set[key] = value;
  return g.update('scanning_sessions', {
    tag: RACE_SESSION_PATCH,
    set,
    where: { id },
    require: 'one',
  });
}
/**
 * The session's device and today's counts, with whether the fence holds, in one snapshot: a count
 * is shown only with the actor and the exact session row it was read for.
 */
export async function scanningSessionStats(
  db: D1Database,
  row: ScanningSessionRow,
  since: number,
  onlineSince: number,
  authority: SessionReadAuthority,
  now: number,
): Promise<{ devices: number; online: number; today: number } | null> {
  if (
    !authority ||
    authority.orgId !== row.org_id ||
    authority.mode !== row.mode ||
    (authority.sessionId !== undefined && authority.sessionId !== row.id)
  )
    return null;
  const [authorized, deviceResult, todayResult] = await db.batch<{
    authorized?: number;
    devices?: number;
    online?: number;
    n?: number;
  }>([
    scanAuthorizedStmt(db, withSessionRow(authority.at(now), row)),
    stmt(
      db,
      `SELECT count(*) AS devices,
        count(CASE WHEN device.last_seen_at>=? THEN 1 END) AS online
      FROM scanning_devices d
      JOIN scanning_sessions x ON x.id=d.session_id AND x.org_id=d.org_id AND x.mode=d.mode
      JOIN scanners device ON device.id=d.scanner_id AND device.org_id=d.org_id AND device.mode=d.mode
      WHERE x.id=? AND x.org_id=? AND x.mode=?
        AND device.revoked_at IS NULL`,
      [onlineSince, row.id, row.org_id, row.mode],
    ),
    scanningSessionTodayStmt(db, row.org_id, row.id, row.mode, since),
  ]);
  if (authorized?.results?.[0]?.authorized !== 1) return null;
  const deviceStats = deviceResult?.results?.[0];
  const todayStats = todayResult?.results?.[0];
  if (
    typeof deviceStats?.devices !== 'number' ||
    typeof deviceStats.online !== 'number' ||
    typeof todayStats?.n !== 'number'
  )
    throw new UnavailableError(
      'Scanning session counts are unavailable.',
      'SCANNING_SESSION_COUNTS_UNAVAILABLE',
    );
  return { devices: deviceStats.devices, online: deviceStats.online, today: todayStats.n };
}

// Materialization keeps the common ledger guards separate from issuance provenance,
// bounding D1 expression depth. A scan belongs to at most one device/session.
export const scanningSessionTodayStmt = (
  db: D1Database,
  orgId: string,
  sessionId: string,
  mode: Mode,
  since: number,
) =>
  stmt(
    db,
    `WITH session_successes AS MATERIALIZED (
      SELECT s.id FROM scans s
      JOIN scanning_devices d ON d.scanner_id=s.scanner_id AND d.org_id=s.org_id AND d.mode=s.mode
      JOIN scanning_sessions x ON x.id=d.session_id AND x.org_id=d.org_id AND x.mode=d.mode
      JOIN scanners device ON device.id=d.scanner_id AND device.org_id=d.org_id AND device.mode=d.mode
      WHERE x.org_id=? AND x.id=? AND x.mode=?
        AND s.org_id=x.org_id AND s.mode=x.mode AND s.at>=?
        AND s.outcome='ok' AND s.action_kind!='undo' AND s.undone_by IS NULL
        AND ${scanLedgerCommonScopeSql('s')}
    )
    SELECT count(*) AS n FROM scans s
    JOIN session_successes matching ON matching.id=s.id
    WHERE ${scanLedgerSuccessfulCandidateSql('s')}`,
    [orgId, sessionId, mode, since],
  );
