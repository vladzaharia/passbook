import { all, run } from '../../platform/db.ts';

export interface RosterRow {
  id: string;
  template_id: string;
  template_version: string;
  personalization: string;
  status: 'active' | 'voided';
  removed_at: number | null;
  deleted_at: number | null;
  scan_code: string | null;
  /** The active printed ticket's 128-bit roster hash, if the pass has one. */
  print_hash: string | null;
  /** A check-in gate in the session's scope says the pass is in. */
  inside: 0 | 1;
}

export interface VoidedPrint {
  pass_id: string;
  roster_hash: string;
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
    `SELECT p.id, p.template_id, p.template_version, p.personalization, p.status, p.removed_at, p.deleted_at,
            p.scan_code,
            (SELECT pp.roster_hash FROM pass_prints pp WHERE pp.pass_id = p.id AND pp.status = 'active') AS print_hash,
            EXISTS (SELECT 1 FROM scan_gates g
                    WHERE g.pass_id = p.id AND g.kind = 'check_in' AND g.state IN ('in', 'used')
                      AND g.scope IN (SELECT value FROM json_each(?))) AS inside
     FROM passes p
     WHERE p.org_id = ? AND p.mode = ? AND p.id > ?
       AND p.template_id IN (SELECT value FROM json_each(?))
       ${
         scope.since === null
           ? ''
           : `AND (p.modified_at >= ?
            OR EXISTS (SELECT 1 FROM scan_gates c WHERE c.pass_id = p.id AND c.kind = 'check_in' AND c.last_at >= ?)
            OR EXISTS (SELECT 1 FROM pass_channels ch WHERE ch.pass_id = p.id AND ch.set_at >= ?)
            OR EXISTS (SELECT 1 FROM pass_prints x WHERE x.pass_id = p.id AND (x.created_at >= ? OR x.voided_at >= ?)))`
       }
     ORDER BY p.id LIMIT ?`,
    [
      JSON.stringify(['', ...scope.gateScopes]),
      scope.orgId,
      scope.mode,
      after,
      JSON.stringify(scope.templateIds),
      ...(scope.since === null
        ? []
        : [scope.since, scope.since, scope.since, scope.since, scope.since]),
      limit,
    ],
  );

/** Prints that ended at or after `since` on the given passes: the device drops their hashes. */
export const voidedPrintsSince = (
  db: D1Database,
  passIds: readonly string[],
  since: number,
): Promise<VoidedPrint[]> =>
  all<VoidedPrint>(
    db,
    `SELECT pass_id, roster_hash FROM pass_prints
     WHERE status = 'voided' AND voided_at >= ? AND pass_id IN (SELECT value FROM json_each(?))`,
    [since, JSON.stringify(passIds)],
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

/** Whether the key's read was recorded: a replay with no row is one whose first run stopped before it. */
export const offlineReadRecorded = async (db: D1Database, actorKey: string, key: string) =>
  (
    await all<{ one: 1 }>(
      db,
      'SELECT 1 AS one FROM scan_offline_reads WHERE actor_key = ? AND idempotency_key = ?',
      [actorKey, key],
    )
  ).length > 0;

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
  /** Dated before the door's last contact or its list: recorded at server time. */
  late: boolean;
  clientTs: number;
  recordedTs: number;
  syncedAt: number;
}

/** One row per uploaded read. A second upload of the same key keeps the first row. */
export const recordOfflineRead = (db: D1Database, r: OfflineRead) =>
  run(
    db,
    `INSERT OR IGNORE INTO scan_offline_reads (id, pass_id, actor_key, idempotency_key, org_id, mode, session_id,
       scanner_id, door, scan_id, outcome, reason, conflict, late, client_ts, recorded_ts, synced_at)
     VALUES (?, (SELECT pass_id FROM scans WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      r.late ? 1 : 0,
      r.clientTs,
      r.recordedTs,
      r.syncedAt,
    ],
  );

export interface SessionChange {
  at: number;
  status: string;
  mode: string;
  prev_status: string;
  prev_mode: string;
  /** Hours, hold and zone as JSON after the change; null on rows from before they were kept. */
  timing: string | null;
  prev_timing: string | null;
}

/** The session's status, offline mode and timing changes, kept by a trigger in the edit's own statement. */
export const sessionChanges = (db: D1Database, sessionId: string) =>
  all<SessionChange>(
    db,
    `SELECT at, status, mode, prev_status, prev_mode, timing, prev_timing FROM scan_session_changes
     WHERE session_id = ? ORDER BY at`,
    [sessionId],
  );

/** When the door last downloaded its list: a listed read cannot be older. */
export const touchRosterAt = (db: D1Database, scannerId: string, orgId: string, now: number) =>
  run(
    db,
    `INSERT INTO scan_offline_state (scanner_id, org_id, online_at, roster_at) VALUES (?, ?, 0, ?)
     ON CONFLICT (scanner_id) DO UPDATE SET roster_at = excluded.roster_at WHERE excluded.roster_at > roster_at`,
    [scannerId, orgId, now],
  );

/** When the door last downloaded its list, or 0. */
export const rosterAtOf = async (db: D1Database, scannerId: string): Promise<number> =>
  (
    await all<{ roster_at: number }>(
      db,
      'SELECT roster_at FROM scan_offline_state WHERE scanner_id = ?',
      [scannerId],
    )
  )[0]?.roster_at ?? 0;
