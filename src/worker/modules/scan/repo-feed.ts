import type { Mode } from '../../../shared/contracts/common.ts';
import type { ApiKeyAuth } from '../../platform/auth.ts';
import { exactStmt, first } from '../../platform/db.ts';
import { keyHoldsScope, keyLive } from '../../platform/repo-api-key-sql.ts';
import { scanLedgerScopeSql, where } from './repo-feed-scope.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import { type ScanReadAuthority, scanAuthorizedStmt, scanRead } from './repo-read-authority.ts';

export { auditScanExport } from './repo-feed-console.ts';
export { scanLedgerScopeSql } from './repo-feed-scope.ts';

type Db = D1Database;

export interface ScanLogFilter {
  mode: Mode;
  orgId?: string | undefined;
  scannerId?: string | undefined;
  staffId?: string | undefined;
  eventId?: string | undefined;
  templateId?: string | undefined;
  passId?: string | undefined;
  outcome?: string | undefined;
  q?: string | undefined;
  reason?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  /** The request clock, used to determine whether pass-derived data may be projected. */
  now?: number | undefined;
  /** The opaque continuation token the caller decodes; the SQL never sees it. */
  cursor?: string | undefined;
  /** The decoded `(at, id)` position of the last row of the previous page. */
  internalCursor?: { at: number; id: string } | undefined;
  limit: number;
}

/**
 * A platform key naming no org narrows by a scanner, staff, event or pass: the `+` keeps the planner
 * on that column's index, as `scans_mode_at` would read every scan of the mode and sort them.
 */
function narrowTenant(f: ScanLogFilter, auth: ScanReadAuthority): string | undefined {
  return !f.orgId && (f.scannerId || f.staffId || f.eventId || f.passId)
    ? auth.tenantOnce('+s', 'scans')
    : undefined;
}

/**
 * Newest first, the org and mode from the fence. An org list rides `scans_org`; a scanner, staff,
 * event or pass filter rides its own index. The page, its authority and everything its disclosure
 * rests on come from one snapshot.
 */
export function listScanRows(db: Db, auth: ScanReadAuthority, f: ScanLogFilter, now: number) {
  const w = where(f);
  const tenant = narrowTenant(f, auth);
  return readHistoryPage(
    db,
    auth,
    { where: w.sql, params: w.params, limit: f.limit, ...(tenant ? { tenant } : {}) },
    now,
  );
}

/** One scan by id, under the same authority as the list. */
export function getScanRow(db: Db, auth: ScanReadAuthority, id: string, now: number) {
  return readHistoryPage(
    db,
    auth,
    { where: `s.id = ? AND ${scanLedgerScopeSql('s')}`, params: [id], limit: 1 },
    now,
  );
}

/** Why the keyed feed refused: an invalid key (401), or a key without the scope or the org (403). */
export async function getApiKeyFeedStatus(
  db: Db,
  auth: ApiKeyAuth,
  filter: ScanLogFilter,
  now: number,
): Promise<'ok' | 'invalid' | 'forbidden'> {
  const live = keyLive('k', now);
  const holds = keyHoldsScope('k', 'scans:read');
  const row = await exactStmt(
    db,
    `SELECT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ? AND k.org_id IS ? AND k.mode = ?
        AND ${live.sql}
        AND (k.org_id IS NULL OR EXISTS (
          SELECT 1 FROM orgs o WHERE o.id = k.org_id AND o.status = 'active'
        ))) AS live,
      EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ? AND ${holds.sql}) AS scopes`,
    [auth.keyId, auth.orgId, auth.mode, ...live.params, auth.keyId, ...holds.params],
  ).first<{ live: number; scopes: number }>();
  const isLive = row?.live === 1;
  const scopes = row?.scopes === 1;
  if (!isLive) return 'invalid';
  if (
    !scopes ||
    filter.mode !== auth.mode ||
    (auth.orgId !== null && filter.orgId !== undefined && filter.orgId !== auth.orgId)
  )
    return 'forbidden';
  return 'ok';
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

/** Rows the filter matches, counted up to `cap + 1`, with whether the fence holds. */
export async function countScanRows(
  db: Db,
  auth: ScanReadAuthority,
  f: ScanLogFilter,
  cap: number,
): Promise<{ authorized: boolean; n: number }> {
  const w = where(f);
  const [authorized, count] = await db.batch([
    scanAuthorizedStmt(db, auth),
    scanRead(
      db,
      auth,
      `SELECT count(*) AS n FROM (SELECT 1 FROM scans s
        WHERE ${auth.ok} AND ${narrowTenant(f, auth) ?? auth.tenant('s', 'scans')} AND ${w.sql} LIMIT ?)`,
      [...w.params, cap + 1],
    ),
  ]);
  const ok = (authorized?.results[0] as { authorized: number } | undefined)?.authorized === 1;
  return { authorized: ok, n: ok ? ((count?.results[0] as { n: number } | undefined)?.n ?? 0) : 0 };
}
