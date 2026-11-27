// The scalar-form statements of the second half of the scan readers, as they were before P2b, kept so
// scan-read-once-more.test.ts can show the join-once statements return the same rows for every actor.
import type { SqlValue } from '../../platform/db.ts';
import { effectiveReleaseIs } from './effective-release.ts';
import { HEADS_UP_SQL, REFUSED_SQL } from './outcome-bucket.ts';
import type { ScanLogFilter } from './repo-feed.ts';
import { where } from './repo-feed-scope.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import { type LegacyAuth, legacyRead } from './repo-read-once-legacy-auth.ts';
import type { ScanRow } from './repo-scans.ts';
import { QUARTER } from './repo-summary-extras.ts';

export const legacyAuthorizedStmt = (db: D1Database, auth: LegacyAuth) =>
  legacyRead(db, auth, `SELECT ${auth.ok} AS authorized`);

export const legacyBrandingStmt = (db: D1Database, auth: LegacyAuth) =>
  legacyRead(
    db,
    auth,
    `SELECT (SELECT o.branding FROM orgs o WHERE o.id = (SELECT org_id FROM actor_ok)) AS branding
     WHERE ${auth.ok}`,
  );

export const legacyClaimStmt = (
  db: D1Database,
  auth: LegacyAuth,
  actorKey: string,
  row: ScanRow,
  idempotencyKey: string,
) =>
  legacyRead(
    db,
    auth,
    `SELECT CASE WHEN ${auth.ok} AND EXISTS (SELECT 1 FROM scans existing
        WHERE existing.id = ? AND existing.at = ? AND existing.state = ? AND existing.reason IS ?
          AND existing.actor_key = ? AND existing.idempotency_key = ? AND existing.request_hash = ?
          AND ${auth.tenant('existing', 'scans')}) THEN 1 ELSE 0 END AS authorized`,
    [row.id, row.at, row.state, row.reason, actorKey, idempotencyKey, row.requestHash],
  );

export const legacyOwnedReceiptStmt = (
  db: D1Database,
  auth: LegacyAuth,
  own: { sql: string; params: SqlValue[] },
  scanId: string,
) =>
  legacyRead(
    db,
    auth,
    `SELECT 1 AS authorized FROM scans s
        WHERE ${auth.ok} AND s.id = ? AND ${auth.tenant('s', 'scans')} AND ${own.sql}`,
    [scanId, ...own.params],
  );

/** The passless read and the replay projection: the same text, over the actor's own columns. */
export const legacyActorFenceStmt = (
  db: D1Database,
  auth: LegacyAuth,
  inner: { sql: string; params: SqlValue[] },
  select = '1 AS ok',
) =>
  legacyRead(
    db,
    auth,
    `SELECT ${select} FROM actor_ok WHERE ${inner.sql.replace(/\bao\./g, 'actor_ok.')}`,
    inner.params,
  );

export function legacyPreviewStmt(
  db: D1Database,
  auth: LegacyAuth,
  pass: {
    id: string;
    templateId: string;
    credentialGeneration: number;
    lifecycleGeneration: number;
  },
  releaseId: string | null,
) {
  return legacyRead(
    db,
    auth,
    `SELECT ${auth.ok} AS actor_ok,
      EXISTS (SELECT 1 FROM passes p
        WHERE ${auth.ok} AND p.id = ? AND ${auth.tenant('p', 'passes')} AND p.template_id = ?
          AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
          AND ${effectiveReleaseIs('p')}) AS pass_ok`,
    [pass.id, pass.templateId, pass.credentialGeneration, pass.lifecycleGeneration, releaseId],
  );
}

export const legacyPreviewActorStmt = (db: D1Database, auth: LegacyAuth) =>
  legacyRead(db, auth, `SELECT ${auth.ok} AS actor_ok`);

export function legacyNotesStmt(
  db: D1Database,
  auth: LegacyAuth,
  q: { passId: string; templateId: string; generation: number; limit: number },
) {
  return legacyRead(
    db,
    auth,
    `SELECT n.id, n.created_at, n.body, n.author_name, n.author_staff_id, n.scanner_id, n.edited_at
     FROM pass_notes n
     JOIN passes p ON p.id = n.pass_id AND p.org_id = n.org_id AND p.mode = n.mode
       AND p.credential_generation = n.credential_generation
     WHERE ${auth.ok} AND ${auth.tenant('n', 'pass_notes')}
       AND n.pass_id = ? AND p.template_id = ? AND n.credential_generation = ?
       AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.test_data_quarantined = 0
     ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    [q.passId, q.templateId, q.generation, q.limit],
  );
}

export function legacyAssetStmt(
  db: D1Database,
  auth: LegacyAuth,
  pass: { id: string; credentialGeneration: number; lifecycleGeneration: number },
  scope: { sql: string; params: SqlValue[] },
  releaseId: string | null,
) {
  return legacyRead(
    db,
    auth,
    `SELECT 1 AS ok FROM passes p
      WHERE ${auth.ok} AND p.id = ? AND ${auth.tenant('p', 'passes')}
        AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
        AND ${effectiveReleaseIs('p')} AND ${scope.sql}`,
    [pass.id, pass.credentialGeneration, pass.lifecycleGeneration, releaseId, ...scope.params],
  );
}

export const legacyFeedCountStmt = (
  db: D1Database,
  auth: LegacyAuth,
  f: ScanLogFilter,
  cap: number,
) => {
  const w = where(f);
  const narrow =
    !f.orgId && (f.scannerId || f.staffId || f.eventId || f.passId)
      ? auth.tenant('+s', 'scans')
      : auth.tenant('s', 'scans');
  return legacyRead(
    db,
    auth,
    `SELECT count(*) AS n FROM (SELECT 1 FROM scans s
        WHERE ${auth.ok} AND ${narrow} AND ${w.sql} LIMIT ?)`,
    [...w.params, cap + 1],
  );
};

export const legacySummaryTotalsStmt = (
  db: D1Database,
  auth: LegacyAuth,
  own: { sql: string; params: SqlValue[] },
  window: { from: number; to: number },
) =>
  legacyRead(
    db,
    auth,
    `SELECT COUNT(*) AS total,
        COALESCE(SUM(s.outcome = 'ok'), 0) AS ok,
        COALESCE(SUM(${HEADS_UP_SQL}), 0) AS heads_up,
        COALESCE(SUM(s.outcome IS NOT 'ok' AND NOT ${HEADS_UP_SQL}), 0) AS refused,
        COALESCE(SUM(s.undone_by IS NOT NULL), 0) AS undone,
        MIN(s.at) AS first_at, MAX(s.at) AS last_at
      FROM scans s WHERE ${auth.ok} AND ${auth.tenant('+s', 'scans')} AND ${own.sql} AND s.at >= ? AND s.at <= ? AND s.action_kind IS NOT 'undo'`,
    [...own.params, window.from, window.to],
  );

/** Every statement of `readSummaryExtras` over the rows `scope` selects, in its order. */
export function legacyExtrasStmts(
  db: D1Database,
  auth: LegacyAuth,
  scope: { where: string; params: readonly SqlValue[] },
  window: { from: number; to: number },
): D1PreparedStatement[] {
  const fromOf = (joins = '') => `FROM scans s
    LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = s.org_id${joins}
    WHERE ${auth.ok} AND ${auth.tenant('+s', 'scans')} AND ${scope.where}
      AND s.at >= ? AND s.at <= ? AND s.action_kind IS NOT 'undo' AND s.outcome IS NOT NULL`;
  const from = fromOf();
  const params = [...scope.params, window.from, window.to];
  const refused = `COALESCE(SUM(${REFUSED_SQL}), 0)`;
  const read = (sql: string) => legacyRead(db, auth, sql, params);
  return [
    read(`SELECT COUNT(*) AS total, COALESCE(SUM(s.outcome = 'ok'), 0) AS ok,
        COALESCE(SUM(${HEADS_UP_SQL}), 0) AS heads_up, ${refused} AS refused,
        COALESCE(SUM(s.undone_by IS NOT NULL), 0) AS undone,
        MIN(s.at) AS first_at, MAX(s.at) AS last_at ${from}`),
    read(
      `SELECT s.at / ${QUARTER} AS q, COUNT(*) AS n, ${refused} AS refused ${from} GROUP BY q ORDER BY q`,
    ),
    read(`SELECT s.action_kind AS kind, COUNT(*) AS n, COALESCE(SUM(s.amount), 0) AS amount ${from}
        AND s.outcome = 'ok' AND s.undone_by IS NULL
        AND s.action_kind IS NOT NULL AND s.action_kind <> 'check_in' GROUP BY s.action_kind`),
    read(`SELECT s.reason AS reason, COUNT(*) AS n ${from}
        AND s.outcome IS NOT 'ok' AND s.reason IS NOT NULL GROUP BY s.reason ORDER BY n DESC, s.reason LIMIT 20`),
    read(`SELECT s.template_id AS id, tt.name AS name, COUNT(*) AS n ${fromOf(`
    LEFT JOIN templates tt ON tt.id = s.template_id AND (tt.org_id IS NULL OR tt.org_id = s.org_id)`)}
        AND s.outcome = 'ok' GROUP BY s.template_id ORDER BY n DESC, tt.name`),
    read(`SELECT s.staff_id AS staff_id, st.name AS name, COUNT(*) AS n,
        COALESCE(SUM(s.override_of IS NOT NULL), 0) AS overrides, ${refused} AS refused ${from}
        GROUP BY s.staff_id ORDER BY n DESC, s.staff_id LIMIT 50`),
    read(`SELECT COUNT(*) AS n ${from} AND s.override_of IS NOT NULL`),
    read(`SELECT s.id AS id, s.at AS at, st.name AS staff_name, ap.name AS approver, ov.reason AS reason
        ${fromOf(`
    LEFT JOIN scan_staff ap ON ap.id = s.approved_by AND ap.org_id = s.org_id
    LEFT JOIN scans ov ON ov.id = s.override_of AND ov.org_id = s.org_id`)}
        AND s.override_of IS NOT NULL ORDER BY s.at DESC, s.id DESC LIMIT 20`),
  ];
}
