import type { SqlValue } from '../../platform/db.ts';
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
        WHERE d.org_id=(SELECT org_id FROM actor_ok) AND d.mode=(SELECT mode FROM actor_ok)
          AND d.session_id=? AND s.device_role='scan' AND s.revoked_at IS NULL ORDER BY s.id
      )) AS session_watch
      FROM scanners screen LEFT JOIN scanner_setups m
        ON m.scanner_id=screen.id AND m.org_id=screen.org_id AND m.mode=screen.mode
      WHERE screen.id=? AND ${auth.tenant('screen', 'scanners')} AND ${auth.ok}`,
    [sessionId, scannerId],
  );
}

/**
 * Per ring row: `scan_ok` (the scan is still a retained, finished scan of this pass; true for a row
 * without a scan), `pass_ok` (0: not visible, 1: visible, 2: visible and its image generation is the
 * one the scan saw). A pass is visible to the recipient while it is live at the generations the scan
 * saw, under the release it was used under, inside the recipient's own scope. One statement; no row
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
    ]),
  );
  const params: SqlValue[] = [];
  const passOk = scope
    ? `(SELECT CASE WHEN p.image_generation = ring.img THEN 2 ELSE 1 END FROM passes p
        WHERE ring.pass_id IS NOT NULL AND ring.cred IS NOT NULL AND p.id = ring.pass_id
          AND ${auth.tenant('p', 'passes')}
          AND ${passVisibleSql('p', { credential: 'ring.cred', lifecycle: 'ring.life' })}
          AND ${effectiveReleaseIdSql('p')} IS ring.rel AND ${scope.sql})`
    : '0';
  if (scope) params.push(...scope.params);
  return scanRead(
    db,
    auth,
    `SELECT ring.i AS i,
      CASE WHEN ring.scan_id IS NULL THEN 1 ELSE EXISTS (SELECT 1 FROM scans s
        WHERE s.id = ring.scan_id AND ${auth.tenant('s', 'scans')} AND s.pass_id IS ring.pass_id
          AND s.state = 'done' AND NOT ${scanRetentionExcludedSql('s')}) END AS scan_ok,
      COALESCE(${passOk}, 0) AS pass_ok
    FROM ring WHERE ${auth.ok}`,
    params,
    {
      ctes: `ring AS MATERIALIZED (SELECT json_extract(value,'$[0]') AS i,
        json_extract(value,'$[1]') AS scan_id, json_extract(value,'$[2]') AS pass_id,
        json_extract(value,'$[3]') AS cred, json_extract(value,'$[4]') AS life,
        json_extract(value,'$[5]') AS img, json_extract(value,'$[6]') AS rel
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
  return scanRead(
    db,
    auth,
    `SELECT mp.r2_key AS r2_key, mp.version AS version
      FROM passes p JOIN member_photos mp ON mp.pass_id = p.id AND mp.org_id = p.org_id
      WHERE ${auth.ok} AND p.id = ? AND ${auth.tenant('p', 'passes')}
        AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
        AND p.image_generation = ? AND ${effectiveReleaseIdSql('p')} IS ? AND ${scope.sql}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM scans s
          WHERE s.id = ? AND ${auth.tenant('s', 'scans')} AND s.pass_id = p.id
            AND s.state = 'done' AND NOT ${scanRetentionExcludedSql('s')}))`,
    [
      row.passId,
      gen.credential,
      gen.lifecycle,
      gen.image,
      entry.release,
      ...scope.params,
      entry.scanId,
      entry.scanId,
    ],
  );
}
