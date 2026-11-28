// The scalar-form statements as they were before P2a (`EXISTS (SELECT 1 FROM actor_ok)` and
// `(SELECT org_id FROM actor_ok)` at every use), kept so scan-read-once.test.ts can show the join-once
// statements return the same rows for every actor.
import type { Mode } from '../../../shared/contracts/common.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { effectiveReleaseIdSql, usedRelease } from './effective-release.ts';
import type { LiveRingRow } from './live-ring.ts';
import type { LookupEntry } from './lookup-history.ts';
import { RACE_PASS_OK } from './race-tags.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import { refsClear } from './repo-read-fences.ts';
import { type LegacyAuth, legacyRead } from './repo-read-once-legacy-auth.ts';
import { actorPassScopeSql } from './repo-recipient-scope.ts';
import { scanRetentionExcludedSql } from './repo-scan-retention.ts';

export function legacyLiveRecipientStmt(
  db: D1Database,
  auth: LegacyAuth,
  actor: ScanActor,
  scannerId: string,
): D1PreparedStatement {
  const sessionId =
    actor.scanningSession && actor.scanningSession.id !== scannerId
      ? actor.scanningSession.id
      : null;
  return legacyRead(
    db,
    auth,
    `SELECT m.watch,
      (SELECT json_group_array(id) FROM (
        SELECT s.id FROM scanning_devices d
        JOIN scanning_sessions p ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
        JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id AND s.mode=d.mode
        WHERE d.org_id=(SELECT org_id FROM actor_ok) AND d.mode=(SELECT mode FROM actor_ok)
          AND d.session_id=? AND s.device_role='scan' AND s.revoked_at IS NULL ORDER BY s.id
      )) AS session_watch,
      (SELECT p.settings FROM scanning_sessions p
        WHERE p.id=? AND p.org_id=(SELECT org_id FROM actor_ok) AND p.mode=(SELECT mode FROM actor_ok)
      ) AS session_settings,
      (SELECT d.overrides FROM scanning_devices d
        WHERE d.scanner_id=screen.id AND d.session_id=? AND d.org_id=(SELECT org_id FROM actor_ok)
          AND d.mode=(SELECT mode FROM actor_ok)) AS screen_overrides
      FROM scanners screen LEFT JOIN scanner_setups m
        ON m.scanner_id=screen.id AND m.org_id=screen.org_id AND m.mode=screen.mode
      WHERE screen.id=? AND ${auth.tenant('screen', 'scanners')} AND ${auth.ok}`,
    [sessionId, sessionId, sessionId, scannerId],
  );
}

export function legacyLiveRowsStmt(
  db: D1Database,
  auth: LegacyAuth,
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
          AND ${auth.tenant('p', 'passes')}
          AND ${passVisibleSql('p', { credential: 'ring.cred', lifecycle: 'ring.life' })}
          AND ${effectiveReleaseIdSql('p')} IS ring.rel AND ${scope.sql}
          AND NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tomb, json_each(ring.refs) j
            WHERE tomb.org_id = p.org_id AND tomb.mode = p.mode
              AND tomb.credential_hash BETWEEN j.value || '${'0'.repeat(48)}'
                AND j.value || '${'f'.repeat(48)}'))`
    : '0';
  if (scope) params.push(...scope.params);
  return legacyRead(
    db,
    auth,
    `${RACE_PASS_OK} SELECT ring.i AS i,
      CASE WHEN ring.scan_id IS NULL THEN 1 ELSE EXISTS (SELECT 1 FROM scans s
        WHERE s.id = ring.scan_id AND ${auth.tenant('s', 'scans')} AND s.pass_id IS ring.pass_id
          AND s.state = 'done' AND NOT ${scanRetentionExcludedSql('s')}) END AS scan_ok,
      COALESCE(${passOk}, 0) AS pass_ok,
      CASE WHEN ring.staff_id IS NULL THEN 1 ELSE EXISTS (SELECT 1 FROM scan_staff st
        WHERE st.id = ring.staff_id AND st.org_id = (SELECT org_id FROM actor_ok)
          AND st.auth_epoch = ring.staff_epoch AND st.disabled_at IS NULL) END AS staff_ok
    FROM ring WHERE ${auth.ok}`,
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

export function legacyLivePhotoStmt(
  db: D1Database,
  auth: LegacyAuth,
  actor: ScanActor,
  entry: LiveRingRow,
): D1PreparedStatement | null {
  const scope = actorPassScopeSql(actor, 'p');
  const { gen, row } = entry;
  if (!scope || !gen || !row.passId) return null;
  // A staffless monitor reads with the role the source had: only while that staff binding holds.
  const borrowed = actor.role === null && entry.sourceStaff !== null;
  const prefixes = entry.refPrefixes.slice(0, 3);
  return legacyRead(
    db,
    auth,
    `SELECT mp.r2_key AS r2_key, mp.version AS version
      FROM passes p JOIN member_photos mp ON mp.pass_id = p.id AND mp.org_id = p.org_id
      WHERE ${auth.ok} AND p.id = ? AND ${auth.tenant('p', 'passes')}
        AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
        AND p.image_generation = ? AND ${effectiveReleaseIdSql('p')} IS ? AND ${scope.sql}
        ${
          entry.scanId !== null
            ? `AND EXISTS (SELECT 1 FROM scans s
          WHERE s.id = ? AND ${auth.tenant('s', 'scans')} AND s.pass_id = p.id
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

export function legacyLookupPassesStmt(
  db: D1Database,
  auth: LegacyAuth,
  actor: ScanActor,
  entries: readonly LookupEntry[],
  refs: readonly string[],
): D1PreparedStatement | null {
  const scope = actorPassScopeSql(actor, 'p');
  const cleared = refsClear(refs, { org: 'p.org_id', mode: 'p.mode' });
  if (!scope || !cleared) return null;
  const ring = JSON.stringify(
    entries.map((entry, i) => {
      const release = usedRelease(entry.source.templateSnapshot?.raw);
      const { pass } = entry.source;
      return [
        i,
        // A release that cannot be read cannot be confirmed: the pass id is withheld.
        release === false ? null : pass.id,
        pass.credentialGeneration,
        pass.lifecycleGeneration,
        pass.imageGeneration,
        release ? release[0] : null,
      ];
    }),
  );
  const params: SqlValue[] = [...scope.params, ...cleared.params];
  return legacyRead(
    db,
    auth,
    `${RACE_PASS_OK} SELECT ring.i AS i,
      COALESCE((SELECT CASE WHEN p.image_generation = ring.img THEN 2 ELSE 1 END FROM passes p
        WHERE p.id = ring.pass_id AND ${auth.tenant('p', 'passes')}
          AND ${passVisibleSql('p', { credential: 'ring.cred', lifecycle: 'ring.life' })}
          AND ${effectiveReleaseIdSql('p')} IS ring.rel AND ${scope.sql} AND ${cleared.sql}), 0) AS pass_ok,
      EXISTS (SELECT 1 FROM passes hp
        WHERE hp.id = ring.pass_id AND ${auth.tenant('hp', 'passes')}) AS present,
      (SELECT ${effectiveReleaseIdSql('hp')} FROM passes hp
        WHERE hp.id = ring.pass_id AND ${auth.tenant('hp', 'passes')}) AS head
    FROM ring WHERE ${auth.ok}`,
    params,
    {
      ctes: `ring AS MATERIALIZED (SELECT json_extract(value,'$[0]') AS i,
        json_extract(value,'$[1]') AS pass_id, json_extract(value,'$[2]') AS cred,
        json_extract(value,'$[3]') AS life, json_extract(value,'$[4]') AS img,
        json_extract(value,'$[5]') AS rel FROM json_each(?))`,
      params: [ring],
    },
  );
}

export function legacyLivePlaceEventStmt(
  db: D1Database,
  auth: LegacyAuth,
  orgId: string,
  mode: Mode,
  eventId: string,
): D1PreparedStatement {
  return legacyRead(
    db,
    auth,
    `SELECT e.name, e.capacity, e.reentry FROM scan_events e
      WHERE e.id=? AND e.org_id=? AND e.mode=? AND e.archived_at IS NULL
        AND ${auth.ok}`,
    [eventId, orgId, mode],
  );
}
