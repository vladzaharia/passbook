import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { dayStartMs } from './dto-console.ts';
import { scanLedgerScopeSql } from './repo-feed.ts';
import { HISTORY_COLUMNS, HISTORY_JOINS } from './repo-history-rows.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';
import { afterCursorSql, type StaffPage, staffNameMatch } from './repo-staff-page.ts';
import type { StaffActivityRaw } from './repo-staff-rows.ts';
import {
  PIN_MISSES_PER_PERSON,
  PIN_MISSES_PER_SCANNER,
  PIN_PERSON_WINDOW_MS,
  PIN_SCANNER_WINDOW_MS,
} from './staff-pin.ts';
import { dayWindowOf, PIN_MISSES_PER_STAFF_DAY } from './staff-pin-day.ts';

/** The scanner time zones of the org and mode: day boundaries need JS `Intl`, so they are read first. */
export async function staffTimeZones(db: D1Database, auth: ScanReadAuthority): Promise<string[]> {
  const rows = await scanRead(
    db,
    auth,
    `SELECT DISTINCT sc.time_zone FROM scanners sc WHERE ${auth.ok} AND ${auth.tenant('sc', 'scanners')}`,
  ).all<{ time_zone: string }>();
  return rows.results.map((row) => row.time_zone);
}

/**
 * The staff page with each person's latest scan and everything its disclosure rests on, in one
 * statement under the actor's fence: the page, counts, lockouts and the scanner name's evidence
 * are one snapshot. A scanner whose time zone was not read means the zones changed: `snapshot_ok`.
 * The `+` on the org and mode keeps each person's scans on `scans_staff`: with the mode taken from
 * the fence the planner would walk the org's scans newest first to find one staff member's.
 */
export async function readStaffActivity(
  db: D1Database,
  auth: ScanReadAuthority,
  zones: readonly string[],
  now: number,
  page: StaffPage,
  orgZone: string = DEFAULT_TIME_ZONE,
): Promise<StaffActivityRaw[]> {
  const name = staffNameMatch(page.q);
  const cursor = afterCursorSql(page.cursor);
  const mode = '(SELECT mode FROM actor_ok)';
  const starts = zones.map((zone) => ({ zone, since: dayStartMs(zone, now) }));
  const ctes = `starts AS (
      SELECT json_extract(value, '$.zone') AS zone, json_extract(value, '$.since') AS since
      FROM json_each(?)
    ), scope AS (
      SELECT CASE WHEN ${auth.ok} THEN 1 ELSE 0 END AS auth_ok,
        NOT EXISTS (
          SELECT 1 FROM scanners current_sc
          WHERE ${auth.tenant('current_sc', 'scanners')}
            AND NOT EXISTS (SELECT 1 FROM starts WHERE starts.zone = current_sc.time_zone)
        ) AS snapshot_ok
    ), page AS MATERIALIZED (
      SELECT st.id AS m_id, st.org_id AS m_org_id, st.name AS m_name, st.role AS m_role,
        st.pin_set_at AS m_pin_set_at, st.pin_reset_required AS m_pin_reset, st.disabled_at AS m_disabled_at,
        EXISTS (
          SELECT 1 FROM scanners sc
          WHERE sc.org_id = st.org_id AND sc.mode = ${mode} AND sc.revoked_at IS NULL
            AND sc.kind = 'device' AND sc.device_role = 'scan' AND sc.token_hash IS NOT NULL
            AND (sc.expires_at IS NULL OR sc.expires_at > ?)
            AND COALESCE(sc.last_seen_at, sc.paired_at, ?) + ? > ?
            AND (EXISTS (
              SELECT 1 FROM counters c WHERE c.key = 'scan:pin:' || sc.id || ':' || st.id
                AND c.window_start = ? AND c.count >= ?
            ) OR EXISTS (
              SELECT 1 FROM counters c WHERE c.key = 'scan:pinall:' || sc.id
                AND c.window_start = ? AND c.count >= ?
            ))
        ) AS m_locked,
        EXISTS (
          SELECT 1 FROM counters d WHERE d.key = 'scan:pinday:' || st.id
            AND d.window_start = ? AND d.count >= ?
        ) AS m_day_locked,
        (SELECT count(*) FROM scans s
          LEFT JOIN scanners day_sc ON day_sc.id = s.scanner_id
            AND day_sc.org_id = s.org_id AND day_sc.mode = s.mode
          LEFT JOIN starts ON starts.zone = day_sc.time_zone
          WHERE +s.org_id = st.org_id AND +s.mode = ${mode} AND s.staff_id = st.id
            AND s.at >= CASE WHEN day_sc.id IS NULL THEN ? ELSE starts.since END
            AND s.state = 'done' AND s.outcome = 'ok'
            AND s.undone_at IS NULL AND s.undone_by IS NULL AND s.action_kind != 'undo'
            AND ${scanLedgerScopeSql('s')}
        ) AS m_today,
        (SELECT s.id FROM scans s
          WHERE +s.org_id = st.org_id AND +s.mode = ${mode} AND s.staff_id = st.id AND s.state = 'done'
            AND ${scanLedgerScopeSql('s')}
          ORDER BY s.at DESC, s.id DESC LIMIT 1) AS scan_id
      FROM scope JOIN scan_staff st ON scope.auth_ok = 1 AND scope.snapshot_ok = 1
        AND ${auth.tenant('st', 'scan_staff')}${page.staffId === undefined ? '' : ' AND st.id = ?'}
        AND ${name.sql} ${cursor.sql}
      ORDER BY st.disabled_at IS NOT NULL, st.name COLLATE NOCASE, st.id LIMIT ?
    )`;
  const params = [
    JSON.stringify(starts),
    now,
    now,
    DEVICE_IDLE_MS,
    now,
    now - (now % PIN_PERSON_WINDOW_MS),
    PIN_MISSES_PER_PERSON,
    now - (now % PIN_SCANNER_WINDOW_MS),
    PIN_MISSES_PER_SCANNER,
    dayWindowOf(now),
    PIN_MISSES_PER_STAFF_DAY,
    dayStartMs(orgZone, now),
    ...(page.staffId === undefined ? [] : [page.staffId]),
    ...name.params,
    ...cursor.params,
    page.limit + 1,
  ];
  const result = await scanRead(
    db,
    auth,
    `SELECT scope.auth_ok, scope.snapshot_ok, page.*, ${HISTORY_COLUMNS}
     FROM scope LEFT JOIN page ON 1 ${HISTORY_JOINS}
     ORDER BY page.m_disabled_at IS NOT NULL, page.m_name COLLATE NOCASE, page.m_id`,
    [now],
    { ctes, params },
  ).all<StaffActivityRaw>();
  return result.results;
}
