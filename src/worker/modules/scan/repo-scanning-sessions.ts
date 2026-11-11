import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanningSession } from '../../../shared/contracts/scanning-sessions.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { all, first, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import {
  credentialRefKeysetInitializeStmt,
  credentialRefKeysetSql,
} from '../passes/repo-credential-keyset.ts';
import { scanLedgerCommonScopeSql, scanLedgerSuccessfulCandidateSql } from './repo-feed-scope.ts';
import { packScanPredicate } from './repo-secret-binds.ts';
import type { SessionCountAuthority } from './scanning-session-dto.ts';

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
  created_at: number;
  updated_at: number;
  /** Trigger-owned; an edit derived from this row is checked against it at commit. */
  config_epoch: number;
}
const SELECT = `SELECT s.*,o.name AS org_name FROM scanning_sessions s JOIN orgs o ON o.id=s.org_id`;

export const scanningSessionRow = (db: D1Database, orgId: string | null, id: string) =>
  first<ScanningSessionRow>(db, `${SELECT} WHERE s.id=? AND (? IS NULL OR s.org_id=?)`, [
    id,
    orgId,
    orgId,
  ]);
export const scanningSessionForDevice = (db: D1Database, orgId: string, scannerId: string) =>
  first<ScanningSessionRow>(
    db,
    `${SELECT} JOIN scanning_devices d ON d.session_id=s.id AND d.org_id=s.org_id AND d.mode=s.mode
    JOIN scanners device ON device.id=d.scanner_id AND device.org_id=d.org_id AND device.mode=d.mode
    WHERE d.scanner_id=? AND s.org_id=?`,
    [scannerId, orgId],
  );
export const listScanningSessionRows = (
  db: D1Database,
  mode: Mode,
  query: { orgId?: string; cursor?: string; limit: number },
) =>
  all<ScanningSessionRow>(
    db,
    `${SELECT} WHERE s.mode=? AND (? IS NULL OR s.org_id=?) AND (? IS NULL OR s.id<?)
    ORDER BY s.id DESC LIMIT ?`,
    [
      mode,
      query.orgId ?? null,
      query.orgId ?? null,
      query.cursor ?? null,
      query.cursor ?? null,
      query.limit + 1,
    ],
  );

/** org_id and mode come from the grant row. */
export const addScanningSessionInsert = (
  g: Grant,
  row: Omit<ScanningSessionRow, 'org_name' | 'org_id' | 'mode' | 'config_epoch'>,
  userId: string,
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
      'created_at',
      'updated_at',
      'created_by',
    ],
    [
      row.id,
      row.name,
      row.status,
      row.accepts,
      row.settings,
      row.time_zone,
      row.created_at,
      row.updated_at,
      userId,
    ],
  );

/** Only the columns the edit names: a concurrent rename or status change survives. */
export function addScanningSessionUpdate(
  g: Grant,
  id: string,
  patch: Partial<
    Pick<ScanningSessionRow, 'name' | 'status' | 'accepts' | 'settings' | 'time_zone'>
  >,
  now: number,
): GrantedStatement {
  const set: Record<string, SetValue> = { updated_at: maxNow(now) };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) set[key] = value;
  return g.update('scanning_sessions', { set, where: { id }, require: 'one' });
}
/** A count is usable only with the original actor and exact row in the same snapshot. */
export async function scanningSessionStats(
  db: D1Database,
  row: ScanningSessionRow,
  since: number,
  onlineSince: number,
  authority: SessionCountAuthority,
  now: number,
): Promise<{ devices: number; online: number; today: number } | null> {
  if (
    !authority ||
    authority.orgId !== row.org_id ||
    authority.mode !== row.mode ||
    (authority.sessionId !== undefined && authority.sessionId !== row.id) ||
    !/^[0-9a-f]{64}$/.test(authority.credentialKeysetCommitment)
  )
    return null;
  const current = authority.guardAt(now);
  if (!current) return null;
  const rowGuard = packScanPredicate(
    `EXISTS (
      SELECT 1 FROM scanning_sessions target
      WHERE target.id=?/* scan-ephemeral-session-id */ AND target.org_id=? AND target.mode=?
        AND target.config_epoch=?)`,
    [row.id, row.org_id, row.mode, row.config_epoch],
    'session_count_row',
  );
  if (!rowGuard) return null;
  const guard = {
    sql: `(${current.sql}) AND (${rowGuard.sql})`,
    params: [...current.params, ...rowGuard.params],
  };
  // Keep the existing conservative bind budget for the guarded initializer and
  // authority read; the independent count statements use only their scope binds.
  if (guard.params.length >= 94) return null;
  // D1 executes a batch in one transaction. Resolving the actor/keyset fence and
  // ledger aggregate in separate statements avoids SQLite accumulating their
  // expression depths, while all three results still share the same snapshot.
  const [, authorityResult, deviceResult, todayResult] = await db.batch<{
    keyset?: number;
    devices?: number;
    online?: number;
    n?: number;
  }>([
    credentialRefKeysetInitializeStmt(db, authority.credentialKeysetCommitment, guard),
    stmt(
      db,
      `WITH session_scope AS MATERIALIZED (
        SELECT id, org_id, mode FROM scanning_sessions
        WHERE id=?/* scan-ephemeral-session-id */ AND org_id=? AND mode=?
      )
      SELECT (${credentialRefKeysetSql.replace('?', '?/* scan-ephemeral-proof */')}) AS keyset
      FROM session_scope WHERE (${guard.sql})`,
      [row.id, row.org_id, row.mode, authority.credentialKeysetCommitment, ...guard.params],
    ),
    stmt(
      db,
      `SELECT count(*) AS devices,
        count(CASE WHEN device.last_seen_at>=? THEN 1 END) AS online
      FROM scanning_devices d
      JOIN scanning_sessions x ON x.id=d.session_id AND x.org_id=d.org_id AND x.mode=d.mode
      JOIN scanners device ON device.id=d.scanner_id AND device.org_id=d.org_id AND device.mode=d.mode
      WHERE x.id=?/* scan-ephemeral-session-id */ AND x.org_id=? AND x.mode=?
        AND device.revoked_at IS NULL`,
      [onlineSince, row.id, row.org_id, row.mode],
    ),
    scanningSessionTodayStmt(db, row.org_id, row.id, row.mode, since),
  ]);
  const authorization = authorityResult?.results?.[0];
  if (!authorization) return null;
  if (authorization.keyset !== 1)
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
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
      WHERE x.org_id=? AND x.id=?/* scan-ephemeral-session-id */ AND x.mode=?
        AND s.org_id=x.org_id AND s.mode=x.mode AND s.at>=?
        AND s.outcome='ok' AND s.action_kind!='undo' AND s.undone_by IS NULL
        AND ${scanLedgerCommonScopeSql('s')}
    )
    SELECT count(*) AS n FROM scans s
    JOIN session_successes matching ON matching.id=s.id
    WHERE ${scanLedgerSuccessfulCandidateSql('s')}`,
    [orgId, sessionId, mode, since],
  );
