import { all, first, run } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import type { EffectState, Scenario } from './action-gate-stale-budget-core-test-fixtures.ts';
import { PIN_PERSON_WINDOW_MS, PIN_SCANNER_WINDOW_MS } from './staff-pin.ts';

export function insertManagedSession(
  db: D1Database,
  idHash: string,
  userId: string,
  csrf: string,
  now: number,
  absoluteMs: number,
) {
  return run(
    db,
    `INSERT INTO sessions
    (id_hash,user_id,amr,roles,csrf_secret,created_at,last_seen_at,idle_expires_at,expires_at)
    VALUES (?,?,'oidc','["user"]',?,?,?,?,?)`,
    [idHash, userId, csrf, now, now, now + 60_000, now + absoluteMs],
  );
}

export function insertManagedScannerSetup(
  db: D1Database,
  scannerId: string,
  orgId: string,
  userId: string,
) {
  return run(
    db,
    `INSERT INTO scanner_setups (scanner_id,org_id,mode,admin_session,admin_user_id)
      VALUES (?,?,'live',1,?)`,
    [scannerId, orgId, userId],
  );
}

export function signedScanEvent(db: D1Database, passId: string, scanId: string) {
  return first<EventRow>(
    db,
    `SELECT * FROM pass_events
    WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
    [passId, scanId],
  );
}

export function signedScanRetention(db: D1Database, scanId: string) {
  return first(
    db,
    'SELECT ledger_event_id,mac,excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
    [scanId],
  );
}

export async function effects(db: D1Database, s: Scenario): Promise<EffectState> {
  const id = s.pass.id;
  return {
    gates: await all(db, 'SELECT * FROM scan_gates WHERE pass_id=? ORDER BY action_id,scope', [id]),
    presence: await all(db, 'SELECT * FROM scan_presence WHERE pass_id=? ORDER BY scope', [id]),
    scans: await all(db, "SELECT * FROM scans WHERE pass_id=? AND state='done' ORDER BY id", [id]),
    events: await all(
      db,
      "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%' ORDER BY id",
      [id],
    ),
    retention: await all(
      db,
      `SELECT r.* FROM scan_retention_proofs r JOIN pass_events e ON e.id=r.ledger_event_id
      WHERE e.pass_id=? ORDER BY r.scan_id`,
      [id],
    ),
    ledgerAll: await all(
      db,
      "SELECT * FROM pass_events WHERE org_id=? AND kind LIKE 'scan.%' ORDER BY id",
      [s.kit.org.id],
    ),
    retentionAll: await all(
      db,
      'SELECT * FROM scan_retention_proofs WHERE org_id=? ORDER BY scan_id',
      [s.kit.org.id],
    ),
    grants: await all(
      db,
      'SELECT * FROM scan_asset_grant_provenance WHERE org_id=? ORDER BY token_hash',
      [s.kit.org.id],
    ),
  };
}

export async function pinCounts(db: D1Database, s: Scenario, now: number) {
  const get = async (name: string, size: number) =>
    (
      await first<{ count: number }>(
        db,
        'SELECT count FROM counters WHERE key=? AND window_start=?',
        [name, now - (now % size)],
      )
    )?.count ?? 0;
  return {
    person: await get(`scan:pin:${s.scanner.id}:${s.manager.id}`, PIN_PERSON_WINDOW_MS),
    scanner: await get(`scan:pinall:${s.scanner.id}`, PIN_SCANNER_WINDOW_MS),
  };
}

export function seedPinCounter(db: D1Database, name: string, windowStart: number, value: number) {
  return run(
    db,
    `INSERT INTO counters (key,window_start,count) VALUES (?,?,?)
    ON CONFLICT (key,window_start) DO UPDATE SET count=excluded.count`,
    [name, windowStart, value],
  );
}
