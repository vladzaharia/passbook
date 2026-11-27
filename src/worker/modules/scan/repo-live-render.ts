import { exactStmt, type SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { effectiveReleaseIdSql } from './effective-release.ts';
import type { LiveRingRow } from './live-ring.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';
import { actorPassScopeSql } from './repo-recipient-scope.ts';
import { scanRetentionExcludedSql } from './repo-scan-retention.ts';

/** The recipient screen's watch, read under its own authority: no row at all when that fails. */
export function liveRecipientStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  actor: ScanActor,
  scannerId: string,
): D1PreparedStatement {
  const sessionId =
    actor.scanningSession && actor.scanningSession.id !== scannerId
      ? actor.scanningSession.id
      : null;
  return scanRead(
    db,
    auth,
    `SELECT m.watch,
      (SELECT json_group_array(id) FROM (
        SELECT s.id FROM scanning_devices d
        JOIN scanning_sessions p ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
        JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id AND s.mode=d.mode
        WHERE d.org_id=ao.org_id AND d.mode=ao.mode
          AND d.session_id=? AND s.device_role='scan' AND s.revoked_at IS NULL ORDER BY s.id
      )) AS session_watch,
      (SELECT p.settings FROM scanning_sessions p
        WHERE p.id=? AND p.org_id=ao.org_id AND p.mode=ao.mode
      ) AS session_settings,
      (SELECT d.overrides FROM scanning_devices d
        WHERE d.scanner_id=screen.id AND d.session_id=? AND d.org_id=ao.org_id
          AND d.mode=ao.mode) AS screen_overrides
      FROM ${auth.rows}scanners screen LEFT JOIN scanner_setups m
        ON m.scanner_id=screen.id AND m.org_id=screen.org_id AND m.mode=screen.mode
      WHERE screen.id=? AND ${auth.tenantOnce('screen', 'scanners')}`,
    [sessionId, sessionId, sessionId, scannerId],
  );
}

/**
 * Per ring row: `scan_ok` (the scan is still a retained, finished scan of this pass; true for a row
 * without a scan), `pass_ok` (0: not visible, 1: visible, 2: visible and its image generation is the
 * one the scan saw). A pass is visible to the recipient while it is live at the generations the scan
 * saw, under the release it was used under, inside the recipient's own scope, with the scan's
 * credential not retired by a transfer. `staff_ok` is 0 when the source's staff binding the monitor may
 * borrow its role from is disabled or re-keyed. One statement; no row
 * comes back when the recipient's authority fails.
 */
export function liveRowsStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  actor: ScanActor,
  entries: readonly LiveRingRow[],
): D1PreparedStatement {
  const scope = actorPassScopeSql(actor, 'p');
  const ring = JSON.stringify(
    entries.map((e, i) => [
      i,
      e.scanId,
      e.row.passId,
      e.gen?.credential ?? null,
      e.gen?.lifecycle ?? null,
      e.gen?.image ?? null,
      e.release,
      JSON.stringify(e.refPrefixes),
      e.sourceStaff?.id ?? null,
      e.sourceStaff?.authEpoch ?? null,
    ]),
  );
  const params: SqlValue[] = [];
  const passOk = scope
    ? `(SELECT CASE WHEN p.image_generation = ring.img THEN 2 ELSE 1 END FROM passes p
        WHERE ring.pass_id IS NOT NULL AND ring.cred IS NOT NULL AND p.id = ring.pass_id
          AND ${auth.tenantOnce('p', 'passes')}
          AND ${passVisibleSql('p', { credential: 'ring.cred', lifecycle: 'ring.life' })}
          AND ${effectiveReleaseIdSql('p')} IS ring.rel AND ${scope.sql}
          AND NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tomb, json_each(ring.refs) j
            WHERE tomb.org_id = p.org_id AND tomb.mode = p.mode
              AND tomb.credential_hash BETWEEN j.value || '${'0'.repeat(48)}'
                AND j.value || '${'f'.repeat(48)}'))`
    : '0';
  if (scope) params.push(...scope.params);
  return scanRead(
    db,
    auth,
    `SELECT ring.i AS i,
      CASE WHEN ring.scan_id IS NULL THEN 1 ELSE EXISTS (SELECT 1 FROM scans s
        WHERE s.id = ring.scan_id AND ${auth.tenantOnce('s', 'scans')} AND s.pass_id IS ring.pass_id
          AND s.state = 'done' AND NOT ${scanRetentionExcludedSql('s')}) END AS scan_ok,
      COALESCE(${passOk}, 0) AS pass_ok,
      CASE WHEN ring.staff_id IS NULL THEN 1 ELSE EXISTS (SELECT 1 FROM scan_staff st
        WHERE st.id = ring.staff_id AND st.org_id = ao.org_id
          AND st.auth_epoch = ring.staff_epoch AND st.disabled_at IS NULL) END AS staff_ok
    FROM ${auth.rows}ring`,
    params,
    {
      ctes: `ring AS MATERIALIZED (SELECT json_extract(value,'$[0]') AS i,
        json_extract(value,'$[1]') AS scan_id, json_extract(value,'$[2]') AS pass_id,
        json_extract(value,'$[3]') AS cred, json_extract(value,'$[4]') AS life,
        json_extract(value,'$[5]') AS img, json_extract(value,'$[6]') AS rel, json_extract(value,'$[7]') AS refs,
        json_extract(value,'$[8]') AS staff_id, json_extract(value,'$[9]') AS staff_epoch
        FROM json_each(?))`,
      params: [ring],
    },
  );
}

/** The photo of a ring row's pass, under the same fence as the row: no row when any part fails. */
export function livePhotoStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  actor: ScanActor,
  entry: LiveRingRow,
): D1PreparedStatement | null {
  const scope = actorPassScopeSql(actor, 'p');
  const { gen, row } = entry;
  if (!scope || !gen || !row.passId) return null;
  // A staffless monitor reads with the role the source had: only while that staff binding holds.
  const borrowed = actor.role === null && entry.sourceStaff !== null;
  const prefixes = entry.refPrefixes.slice(0, 3);
  return scanRead(
    db,
    auth,
    `SELECT mp.r2_key AS r2_key, mp.version AS version
      FROM ${auth.rows}passes p JOIN member_photos mp ON mp.pass_id = p.id AND mp.org_id = p.org_id
      WHERE p.id = ? AND ${auth.tenantOnce('p', 'passes')}
        AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
        AND p.image_generation = ? AND ${effectiveReleaseIdSql('p')} IS ? AND ${scope.sql}
        ${
          entry.scanId !== null
            ? `AND EXISTS (SELECT 1 FROM scans s
          WHERE s.id = ? AND ${auth.tenantOnce('s', 'scans')} AND s.pass_id = p.id
            AND s.state = 'done' AND NOT ${scanRetentionExcludedSql('s')})`
            : ''
        }
        ${borrowed ? 'AND EXISTS (SELECT 1 FROM scan_staff st WHERE st.id = ? AND st.org_id = p.org_id AND st.auth_epoch = ? AND st.disabled_at IS NULL)' : ''}
        ${
          prefixes.length
            ? `AND NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tomb
          WHERE tomb.org_id = p.org_id AND tomb.mode = p.mode
            AND (${prefixes.map(() => 'tomb.credential_hash BETWEEN ? AND ?').join(' OR ')}))`
            : ''
        }`,
    [
      row.passId,
      gen.credential,
      gen.lifecycle,
      gen.image,
      entry.release,
      ...scope.params,
      ...(entry.scanId !== null ? [entry.scanId] : []),
      ...(borrowed && entry.sourceStaff ? [entry.sourceStaff.id, entry.sourceStaff.authEpoch] : []),
      ...prefixes.flatMap((prefix) => [prefix + '0'.repeat(48), prefix + 'f'.repeat(48)]),
    ],
  );
}

/**
 * The ring rows whose pass is no longer visible at the generations and release the scan saw (any
 * recipient): their identity can be scrubbed from storage. Returns the indexes into `entries`.
 */
export function liveRingStaleStmt(
  db: D1Database,
  orgId: string,
  mode: string,
  entries: readonly LiveRingRow[],
): D1PreparedStatement {
  const ring = JSON.stringify(
    entries.map((e, i) => [
      i,
      e.row.passId,
      e.gen?.credential ?? null,
      e.gen?.lifecycle ?? null,
      e.release,
    ]),
  );
  return exactStmt(
    db,
    `WITH ring AS (SELECT json_extract(value,'$[0]') AS i, json_extract(value,'$[1]') AS pass_id,
        json_extract(value,'$[2]') AS cred, json_extract(value,'$[3]') AS life,
        json_extract(value,'$[4]') AS rel FROM json_each(?))
    SELECT ring.i AS i FROM ring
    WHERE ring.pass_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM passes p
      WHERE p.id = ring.pass_id AND p.org_id = ? AND p.mode = ?
        AND ${passVisibleSql('p', { credential: 'ring.cred', lifecycle: 'ring.life' })}
        AND ${effectiveReleaseIdSql('p')} IS ring.rel)`,
    [ring, orgId, mode],
  );
}
