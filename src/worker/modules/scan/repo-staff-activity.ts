import { all, batch, type SqlValue, stmt } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { dayStartMs } from './dto-console.ts';
import { scanLedgerScopeSql } from './repo-feed.ts';
import {
  type HistoryProofFence,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import { afterCursorSql, likePattern, type StaffPage } from './repo-staff-page.ts';
import { type AdminStaffRaw, type AdminStaffResult, adminStaffRows } from './repo-staff-rows.ts';
import {
  PIN_MISSES_PER_PERSON,
  PIN_MISSES_PER_SCANNER,
  PIN_PERSON_WINDOW_MS,
  PIN_SCANNER_WINDOW_MS,
} from './staff-pin.ts';

type Db = D1Database;

type StaffAuthority = Extract<TenantPassWrite, { kind: 'session' }>;
export type StaffCsrfFence = { sql: string; params: readonly SqlValue[] };

export interface StaffActivityPreparation {
  zones: string[];
  scanIds: string[];
}

/**
 * Identify latest eligible scans and the scanner time zones needed for day boundaries. The
 * final projection checks both again; this read is only used to prepare proofs and timestamps.
 */
export async function prepareStaffActivity(
  db: Db,
  authority: StaffAuthority,
  now: number,
  page: StaffPage,
): Promise<StaffActivityPreparation> {
  const params = tenantPassAuthorityParams(authority, now);
  const staffId = page.staffId;
  const pattern = likePattern(page.q);
  const cursor = afterCursorSql(page.cursor);
  const [zones, scans] = await Promise.all([
    all<{ time_zone: string }>(
      db,
      `SELECT DISTINCT sc.time_zone FROM scanners sc
      WHERE sc.org_id = ? AND sc.mode = ? AND ${tenantPassAuthoritySql(authority, 'sc')}`,
      [authority.orgId, authority.mode, ...params],
    ),
    staffId === undefined
      ? all<{ scan_id: string | null }>(
          db,
          `SELECT (
          SELECT s.id FROM scans s
          WHERE s.org_id = st.org_id AND s.mode = ? AND s.staff_id = st.id AND s.state = 'done'
            AND ${scanLedgerScopeSql('s')}
          ORDER BY s.at DESC, s.id DESC LIMIT 1
        ) AS scan_id FROM scan_staff st
        WHERE st.org_id = ? AND ${tenantPassAuthoritySql(authority, 'st')}
          AND (? IS NULL OR st.name LIKE ? ESCAPE '\\') ${cursor.sql}
        ORDER BY st.disabled_at IS NOT NULL, st.name COLLATE NOCASE, st.id LIMIT ?`,
          [
            authority.mode,
            authority.orgId,
            ...params,
            pattern,
            pattern,
            ...cursor.params,
            page.limit + 1,
          ],
        )
      : all<{ scan_id: string | null }>(
          db,
          `SELECT s.id AS scan_id FROM scans s
        WHERE s.org_id = ? AND s.mode = ? AND s.staff_id = ? AND s.state = 'done'
          AND ${scanLedgerScopeSql('s')} AND ${tenantPassAuthoritySql(authority)}
        ORDER BY s.at DESC, s.id DESC LIMIT 1`,
          [authority.orgId, authority.mode, staffId, ...params],
        ),
  ]);
  return {
    zones: zones.map((row) => row.time_zone),
    scanIds: scans.flatMap((row) => (row.scan_id === null ? [] : [row.scan_id])),
  };
}

/**
 * Re-evaluate the current tenant, staff rows, eligible latest scans, counts, lockouts and every
 * verified name proof in one D1 snapshot. Changed time zones or credential keysets invalidate
 * the prepared projection rather than returning stale activity.
 */
function listAdminStaffStmt(
  db: Db,
  authority: StaffAuthority,
  zones: readonly string[],
  credentialKeysetCommitment: string | null,
  csrfFence: StaffCsrfFence | null,
  now: number,
  page: StaffPage,
): D1PreparedStatement {
  const { staffId } = page;
  const pattern = likePattern(page.q);
  const cursor = afterCursorSql(page.cursor);
  const personWindow = now - (now % PIN_PERSON_WINDOW_MS);
  const scannerWindow = now - (now % PIN_SCANNER_WINDOW_MS);
  const starts = zones.map((zone) => ({ zone, since: dayStartMs(zone, now) }));
  return stmt(
    db,
    `WITH starts AS (
       SELECT json_extract(value, '$.zone') AS zone, json_extract(value, '$.since') AS since
       FROM json_each(?)
     ), scope AS (
       SELECT CASE WHEN ${tenantPassAuthoritySql(authority)}${csrfFence ? ` AND (${csrfFence.sql})` : ''} THEN 1 ELSE 0 END AS auth_ok,
         (${credentialKeysetCommitment === null ? '1' : credentialRefKeysetSql}) AND NOT EXISTS (
           SELECT 1 FROM scanners current_sc
           WHERE current_sc.org_id = ? AND current_sc.mode = ?
             AND NOT EXISTS (SELECT 1 FROM starts WHERE starts.zone = current_sc.time_zone)
         ) AS snapshot_ok
     )
     SELECT scope.auth_ok, scope.snapshot_ok, st.id, st.org_id, st.name, st.role,
       st.pin_set_at, st.disabled_at,
       EXISTS (
         SELECT 1 FROM scanners sc
         WHERE sc.org_id = st.org_id AND sc.mode = ? AND sc.revoked_at IS NULL
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
       ) AS locked,
       (SELECT count(*) FROM scans s
         LEFT JOIN scanners day_sc ON day_sc.id = s.scanner_id
           AND day_sc.org_id = s.org_id AND day_sc.mode = s.mode
         LEFT JOIN starts ON starts.zone = day_sc.time_zone
         WHERE s.org_id = st.org_id AND s.mode = ? AND s.staff_id = st.id
           AND s.at >= CASE WHEN day_sc.id IS NULL THEN ? ELSE starts.since END
           AND s.state = 'done' AND s.outcome = 'ok'
           AND s.undone_at IS NULL AND s.undone_by IS NULL AND s.action_kind != 'undo'
           AND ${scanLedgerScopeSql('s')}
       ) AS today,
       recent_scan.at AS last_at, recent_scan.id AS last_scan_id,
       recent_sc.name AS scanner_name
     FROM scope
     LEFT JOIN scan_staff st ON scope.auth_ok = 1 AND scope.snapshot_ok = 1
       AND st.org_id = ? AND (? IS NULL OR st.id = ?)
       AND (? IS NULL OR st.name LIKE ? ESCAPE '\\') ${cursor.sql}
     LEFT JOIN scans recent_scan ON recent_scan.id = (
       SELECT s.id FROM scans s
       WHERE s.org_id = st.org_id AND s.mode = ? AND s.staff_id = st.id AND s.state = 'done'
         AND ${scanLedgerScopeSql('s')}
       ORDER BY s.at DESC, s.id DESC LIMIT 1
     )
     LEFT JOIN scanners recent_sc ON recent_sc.id = recent_scan.scanner_id
       AND recent_sc.org_id = st.org_id AND recent_sc.mode = recent_scan.mode
     ORDER BY st.disabled_at IS NOT NULL, st.name COLLATE NOCASE, st.id LIMIT ?`,
    [
      JSON.stringify(starts),
      ...tenantPassAuthorityParams(authority, now),
      ...(csrfFence?.params ?? []),
      ...(credentialKeysetCommitment === null ? [] : [credentialKeysetCommitment]),
      authority.orgId,
      authority.mode,
      authority.mode,
      now,
      now,
      DEVICE_IDLE_MS,
      now,
      personWindow,
      PIN_MISSES_PER_PERSON,
      scannerWindow,
      PIN_MISSES_PER_SCANNER,
      authority.mode,
      dayStartMs('UTC', now),
      authority.orgId,
      staffId ?? null,
      staffId ?? null,
      pattern,
      pattern,
      ...cursor.params,
      authority.mode,
      page.limit + 1,
    ],
  );
}

/** Recheck every fragment with private values bound as scalars in the same D1 batch. */
export function adminStaffProjectionPlan(
  db: Db,
  authority: StaffAuthority,
  zones: readonly string[],
  credentialKeysetCommitment: string | null,
  csrfFence: StaffCsrfFence | null,
  proofs: readonly HistoryProofFence[],
  now: number,
  page: StaffPage,
): { statements: D1PreparedStatement[]; fragmentScanIds: string[] } {
  const statements = [
    listAdminStaffStmt(db, authority, zones, credentialKeysetCommitment, csrfFence, now, page),
  ];
  const fragmentScanIds: string[] = [];
  // Name proofs exist only with a keyset; without one every scanner name reads as "Scanner".
  const fence =
    credentialKeysetCommitment !== null && csrfFence
      ? { csrfFence, commitment: credentialKeysetCommitment }
      : null;
  for (const proof of fence ? proofs : []) {
    for (const fragment of historyProofSnapshotPredicates(proof, 'recent_scan', now)) {
      statements.push(
        stmt(
          db,
          `SELECT ? AS scan_id, EXISTS (SELECT 1 FROM scans recent_scan
        WHERE recent_scan.id = ? AND recent_scan.org_id = ? AND recent_scan.mode = ?
          AND (${fence?.csrfFence.sql ?? '0'}) AND (${credentialRefKeysetSql}) AND (${fragment.sql})) AS verified`,
          [
            proof.scan.id,
            proof.scan.id,
            authority.orgId,
            authority.mode,
            ...(fence?.csrfFence.params ?? []),
            fence?.commitment ?? '',
            ...fragment.params,
          ],
        ),
      );
      fragmentScanIds.push(proof.scan.id);
    }
  }
  return { statements, fragmentScanIds };
}

export async function listAdminStaff(
  db: Db,
  authority: StaffAuthority,
  zones: readonly string[],
  credentialKeysetCommitment: string | null,
  csrfFence: StaffCsrfFence | null,
  proofs: readonly HistoryProofFence[],
  now: number,
  page: StaffPage,
): Promise<AdminStaffResult> {
  const plan = adminStaffProjectionPlan(
    db,
    authority,
    zones,
    credentialKeysetCommitment,
    csrfFence,
    proofs,
    now,
    page,
  );
  if (plan.statements.length === 1) {
    const statement = plan.statements[0];
    if (!statement) return { authorized: false, snapshotCurrent: true, items: [], hasMore: false };
    return adminStaffRows([await statement.all<AdminStaffRaw>()], plan.fragmentScanIds, page.limit);
  }
  return adminStaffRows(await batch(db, plan.statements), plan.fragmentScanIds, page.limit);
}
