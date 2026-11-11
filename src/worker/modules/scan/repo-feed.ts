import type { Mode } from '../../../shared/contracts/common.ts';
import type { ApiKeyAuth } from '../../platform/auth.ts';
import { all, chunk, first, type SqlValue, stmt } from '../../platform/db.ts';
import { ConflictError, UnavailableError } from '../../platform/errors.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { toRow } from './repo-feed-map.ts';
import { scanLedgerScopeSql, where } from './repo-feed-scope.ts';
import { SELECT } from './repo-feed-select.ts';
import { scanLogSnapshotPredicate } from './repo-feed-snapshot.ts';
import type { Raw, ScanLogRow } from './repo-feed-types.ts';
import { type OutputPredicate, outputPredicatesCurrent } from './repo-output-predicates.ts';
import { scanPasslessSnapshotPredicate } from './repo-scan-passless.ts';
import type { PasslessScan } from './scan-passless.ts';

export { consoleFeedAuthorityCurrent, scanExportAuditStmt } from './repo-feed-console.ts';
export { scanLedgerScopeSql } from './repo-feed-scope.ts';
export { scanLogSnapshotPredicate } from './repo-feed-snapshot.ts';
export type { ScanEventProof, ScanKeySnapshot, ScanLogRow } from './repo-feed-types.ts';

type Db = D1Database;

export interface ScanLogFilter {
  mode: Mode;
  orgId?: string | undefined;
  scannerId?: string | undefined;
  staffId?: string | undefined;
  eventId?: string | undefined;
  passId?: string | undefined;
  outcome?: string | undefined;
  q?: string | undefined;
  reason?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  /** The request clock, used to determine whether pass-derived data may be projected. */
  now?: number | undefined;
  /** The last scan id of the previous page. */
  cursor?: string | undefined;
  /** Internal continuation from an authenticated token or the last scanned candidate. */
  internalCursor?: { at: number; id: string } | undefined;
  limit: number;
}

/** Newest first. An org list rides `scans_org`; a scanner, staff, event or pass filter rides its own index. */
export async function listScanRows(db: Db, f: ScanLogFilter): Promise<ScanLogRow[]> {
  const now = f.now ?? Date.now();
  const { sql, params } = where(f, now);
  const rows = await all<Raw>(db, `${SELECT} WHERE ${sql} ORDER BY s.at DESC, s.id DESC LIMIT ?`, [
    now,
    ...params,
    f.limit,
  ]);
  return rows.map(toRow);
}

export async function getScanRow(
  db: Db,
  id: string,
  now: number,
  mode: Mode,
): Promise<ScanLogRow | null> {
  const row = await first<Raw>(
    db,
    `${SELECT} WHERE s.id = ? AND ${scanLedgerScopeSql('s')} AND s.mode = ?`,
    [now, id, mode],
  );
  return row ? toRow(row) : null;
}

/** Revalidate previously selected rows in one tenant-scoped transaction. */
export async function getScanRowsByIds(
  db: Db,
  ids: readonly string[],
  now: number,
  mode: Mode,
  orgId: string,
): Promise<ScanLogRow[]> {
  const pages = chunk([...new Set(ids)], 80);
  if (!pages.length) return [];
  const results = await db.batch<Raw>(
    pages.map((page) =>
      stmt(
        db,
        `${SELECT} WHERE s.id IN (${page.map(() => '?/* scan-ephemeral-scan-id */').join(', ')})
      AND s.org_id = ? AND ${scanLedgerScopeSql('s')} AND s.mode = ?`,
        [now, ...page, orgId, mode],
      ),
    ),
  );
  return results.flatMap((result) => result.results.map(toRow));
}

/** Re-read mixed-tenant ledger positions without per-organization or per-row fanout. */
export async function getScanRowsByScopes(
  db: Db,
  scopes: readonly { id: string; orgId: string; mode: Mode }[],
  now: number,
): Promise<ScanLogRow[]> {
  const seen = new Map<string, Map<Mode, Set<string>>>();
  const unique = scopes.filter((scope) => {
    let modes = seen.get(scope.orgId);
    if (!modes) {
      modes = new Map();
      seen.set(scope.orgId, modes);
    }
    let ids = modes.get(scope.mode);
    if (!ids) {
      ids = new Set();
      modes.set(scope.mode, ids);
    }
    if (ids.has(scope.id)) return false;
    ids.add(scope.id);
    return true;
  });
  const pages = chunk(unique, 29);
  if (!pages.length) return [];
  const results = await db.batch<Raw>(
    pages.map((page) =>
      stmt(
        db,
        `WITH requested AS MATERIALIZED (
      SELECT column1 AS id, column2 AS org_id, column3 AS mode FROM
        (VALUES ${page.map(() => '(?/* scan-ephemeral-scan-id */, ?, ?)').join(', ')})
    )
    ${SELECT}
    JOIN requested ON requested.id = s.id AND requested.org_id = s.org_id AND requested.mode = s.mode
    WHERE ${scanLedgerScopeSql('s')}`,
        [...page.flatMap((scope) => [scope.id, scope.orgId, scope.mode]), now],
      ),
    ),
  );
  return results.flatMap((result) => result.results.map(toRow));
}

/** Recheck a continuation boundary without projecting any pass or identity data. */
export function scanLedgerBoundaryPredicate(
  row: ScanLogRow,
  filter: ScanLogFilter,
  now: number,
): OutputPredicate {
  const filtered = where({ ...filter, cursor: undefined, internalCursor: undefined }, now);
  return {
    sql: `EXISTS (SELECT 1 FROM scans s WHERE s.id=?/* scan-ephemeral-scan-id */
      AND s.org_id=? AND s.mode=? AND s.at=? AND (${filtered.sql}))`,
    params: [row.id, row.orgId, row.mode, row.at, ...filtered.params],
  };
}

/** The same exact key and scope checks guard bootstrap and the final feed snapshot. */
export function apiKeyFeedPredicates(
  auth: ApiKeyAuth,
  now: number,
): [OutputPredicate, OutputPredicate] {
  const keyLive: OutputPredicate = {
    sql: `EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ?/* scan-ephemeral-proof */ AND k.org_id IS ? AND k.mode = ?
      AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
      AND (k.org_id IS NULL OR EXISTS (
        SELECT 1 FROM orgs o WHERE o.id = k.org_id AND o.status = 'active'
      )))`,
    params: [auth.keyId, auth.orgId, auth.mode, now],
  };
  const keyScopes: OutputPredicate = {
    sql: `EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ?/* scan-ephemeral-proof */ AND CASE WHEN json_valid(k.scopes) THEN
      json_type(k.scopes) = 'array' AND json(k.scopes) = json(?)
      AND EXISTS (SELECT 1 FROM json_each(k.scopes) scope
        WHERE scope.type = 'text' AND scope.value = 'scans:read')
      ELSE 0 END)`,
    params: [auth.keyId, JSON.stringify(auth.scopes)],
  };
  return [keyLive, keyScopes];
}

export function apiKeyFeedGuard(auth: ApiKeyAuth, now: number): OutputPredicate {
  const [live, scopes] = apiKeyFeedPredicates(auth, now);
  return { sql: `(${live.sql}) AND (${scopes.sql})`, params: [...live.params, ...scopes.params] };
}

/** The staff-hidden path does not inspect history, but must still fence the original key. */
export async function getApiKeyFeedStatus(
  db: Db,
  auth: ApiKeyAuth,
  filter: ScanLogFilter,
  now: number,
): Promise<'ok' | 'invalid' | 'forbidden'> {
  const [live, scopes] = await outputPredicatesCurrent(db, apiKeyFeedPredicates(auth, now));
  if (!live) return 'invalid';
  if (
    !scopes ||
    filter.mode !== auth.mode ||
    (auth.orgId !== null && filter.orgId !== undefined && filter.orgId !== auth.orgId)
  )
    return 'forbidden';
  return 'ok';
}

/**
 * Fence the original key and every selected scan/pass snapshot in a single D1 read transaction.
 * The caller verifies event MACs before this check and serializes only returned rows.
 */
export async function getApiKeyFeedRowsCurrent(
  db: Db,
  auth: ApiKeyAuth,
  filter: ScanLogFilter,
  rows: readonly ScanLogRow[],
  now: number,
  credentialKeysetCommitment: string,
  passlessProofs?: ReadonlyMap<string, PasslessScan>,
  boundary?: ScanLogRow,
): Promise<{ status: 'ok' | 'invalid' | 'forbidden'; rows: ScanLogRow[] }> {
  const [keyLive, keyScopes] = apiKeyFeedPredicates(auth, now);
  const requestMatches =
    filter.mode === auth.mode &&
    (auth.orgId === null || filter.orgId === undefined || filter.orgId === auth.orgId);
  const unpaged = { ...filter, cursor: undefined, internalCursor: undefined };
  const filtered = where(unpaged, now);
  const boundaryCheck = boundary
    ? scanLedgerBoundaryPredicate(boundary, unpaged, now)
    : { sql: '1', params: [] };
  const checks: OutputPredicate[] = rows.flatMap((row) => {
    const passlessProof = passlessProofs?.get(row.id);
    if (
      !requestMatches ||
      row.mode !== auth.mode ||
      (auth.orgId !== null && row.orgId !== auth.orgId) ||
      (row.passId !== null && row.policyAvailable && (!row.eventProof || !row.keySnapshot)) ||
      (row.passlessProofCandidate && row.policyAvailable && !passlessProof)
    )
      return [
        { sql: '0', params: [] },
        { sql: '0', params: [] },
      ];
    const snapshot = scanLogSnapshotPredicate(row, now);
    const passlessSnapshot = passlessProof
      ? scanPasslessSnapshotPredicate('s', passlessProof)
      : null;
    const scope = `EXISTS (SELECT 1 FROM scans s WHERE s.id = ?/* scan-ephemeral-scan-id */ AND s.mode = ?
      AND (? IS NULL OR s.org_id = ?) AND (${filtered.sql}))`;
    const params: SqlValue[] = [
      row.id,
      auth.mode,
      auth.orgId,
      auth.orgId,
      ...filtered.params,
      ...snapshot.params,
    ];
    return [
      {
        sql: `(${scope}) AND (${snapshot.sql}) AND ${credentialRefKeysetSql}`,
        params: [...params, credentialKeysetCommitment],
      },
      passlessSnapshot
        ? {
            sql: `EXISTS (SELECT 1 FROM scans s WHERE s.id = ?/* scan-ephemeral-scan-id */
          AND (${passlessSnapshot.sql})) AND ${credentialRefKeysetSql}`,
            params: [row.id, ...passlessSnapshot.params, credentialKeysetCommitment],
          }
        : { sql: credentialRefKeysetSql, params: [credentialKeysetCommitment] },
    ];
  });
  const results = await outputPredicatesCurrent(db, [
    keyLive,
    keyScopes,
    { sql: credentialRefKeysetSql, params: [credentialKeysetCommitment] },
    {
      sql: `(${boundaryCheck.sql}) AND ${credentialRefKeysetSql}`,
      params: [...boundaryCheck.params, credentialKeysetCommitment],
    },
    ...checks,
  ]);
  if (!results[2])
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  if (!results[0]) return { status: 'invalid', rows: [] };
  if (!results[1] || !requestMatches) return { status: 'forbidden', rows: [] };
  if (!results[3])
    throw new ConflictError('Scan history changed. Reload and retry.', 'SCAN_HISTORY_CHANGED');
  return {
    status: 'ok',
    rows: rows.filter((_, index) => results[index * 2 + 4] && results[index * 2 + 5]),
  };
}

/** Undo needs only the original scope and timestamp, not the private log projection. */
export async function getScanForUndo(db: Db, id: string) {
  const row = await first<{ id: string; org_id: string; mode: Mode; at: number }>(
    db,
    'SELECT id, org_id, mode, at FROM scans WHERE id = ?',
    [id],
  );
  return row ? { id: row.id, orgId: row.org_id, mode: row.mode, at: row.at } : null;
}

/** Rows the filter matches, counted up to `cap + 1`. */
export async function countScanRows(db: Db, f: ScanLogFilter, cap: number): Promise<number> {
  const { sql, params } = where(f, f.now ?? Date.now());
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM (SELECT 1 FROM scans s WHERE ${sql} LIMIT ?)`,
    [...params, cap + 1],
  );
  return row?.n ?? 0;
}
