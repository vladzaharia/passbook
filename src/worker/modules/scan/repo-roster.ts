import { all, run } from '../../platform/db.ts';

export interface RosterRow {
  id: string;
  template_id: string;
  personalization: string;
  status: 'active' | 'voided';
  removed_at: number | null;
  deleted_at: number | null;
  /** SHA-256 hex of the barcode message (64), or null when the pass has none. */
  barcode_hash: string | null;
  scan_code: string | null;
  /** The active printed ticket's 128-bit roster hash, if the pass has one. */
  print_hash: string | null;
  /** A check-in gate in the session's scope says the pass is in. */
  inside: 0 | 1;
}

export interface RosterScope {
  orgId: string;
  mode: 'live' | 'test';
  templateIds: readonly string[];
  /** Gate scopes that count as "already in" for this session (event or venue day). */
  gateScopes: readonly string[];
  /** Only passes or gates changed since this instant; null reads everything. */
  since: number | null;
}

/**
 * One page of passes in scope, by id. Event pass filters are applied by the caller: the page is
 * bounded by `limit` before them, so `after` always moves forward.
 */
export const rosterPage = (
  db: D1Database,
  scope: RosterScope,
  after: string,
  limit: number,
): Promise<RosterRow[]> =>
  all<RosterRow>(
    db,
    `SELECT p.id, p.template_id, p.personalization, p.status, p.removed_at, p.deleted_at,
            p.barcode_hash, p.scan_code,
            (SELECT pp.roster_hash FROM pass_prints pp WHERE pp.pass_id = p.id AND pp.status = 'active') AS print_hash,
            EXISTS (SELECT 1 FROM scan_gates g
                    WHERE g.pass_id = p.id AND g.kind = 'check_in' AND g.state IN ('in', 'used')
                      AND g.scope IN (SELECT value FROM json_each(?))) AS inside
     FROM passes p
     WHERE p.org_id = ? AND p.mode = ? AND p.id > ?
       AND p.template_id IN (SELECT value FROM json_each(?))
       AND (? IS NULL OR p.modified_at >= ?
            OR EXISTS (SELECT 1 FROM scan_gates c WHERE c.pass_id = p.id AND c.kind = 'check_in' AND c.last_at >= ?))
     ORDER BY p.id LIMIT ?`,
    [
      JSON.stringify(['', ...scope.gateScopes]),
      scope.orgId,
      scope.mode,
      after,
      JSON.stringify(scope.templateIds),
      scope.since,
      scope.since,
      scope.since,
      limit,
    ],
  );

/** The scan a key already produced, so a replay after the session closed returns its first answer. */
export const offlineReadScan = async (db: D1Database, actorKey: string, key: string) =>
  (
    await all<{ scan_id: string | null }>(
      db,
      'SELECT scan_id FROM scan_offline_reads WHERE actor_key = ? AND idempotency_key = ?',
      [actorKey, key],
    )
  )[0]?.scan_id ?? null;

export interface OfflineRead {
  id: string;
  actorKey: string;
  idempotencyKey: string;
  orgId: string;
  mode: 'live' | 'test';
  sessionId: string | null;
  scannerId: string | null;
  door: 'listed' | 'unverified' | 'refused';
  scanId: string | null;
  outcome: 'ok' | 'heads_up' | 'refused';
  reason: string | null;
  conflict: boolean;
  clientTs: number;
  recordedTs: number;
  syncedAt: number;
}

/** One row per uploaded read. A second upload of the same key keeps the first row. */
export const recordOfflineRead = (db: D1Database, r: OfflineRead) =>
  run(
    db,
    `INSERT OR IGNORE INTO scan_offline_reads (id, pass_id, actor_key, idempotency_key, org_id, mode, session_id,
       scanner_id, door, scan_id, outcome, reason, conflict, client_ts, recorded_ts, synced_at)
     VALUES (?, (SELECT pass_id FROM scans WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.scanId,
      r.actorKey,
      r.idempotencyKey,
      r.orgId,
      r.mode,
      r.sessionId,
      r.scannerId,
      r.door,
      r.scanId,
      r.outcome,
      r.reason,
      r.conflict ? 1 : 0,
      r.clientTs,
      r.recordedTs,
      r.syncedAt,
    ],
  );
