import type { Mode } from '../../../shared/contracts/common.ts';
import { first, run } from '../../platform/db.ts';

type Db = D1Database;

/** The device side of a `scanners` row. Console CRUD SQL lives in repo-scanners.ts (stream SC). */
export interface ScannerRow {
  id: string;
  orgId: string;
  mode: Mode;
  kind: 'device' | 'terminal';
  name: string;
  eventId: string | null;
  settings: string;
  timeZone: string;
  tokenPrefix: string | null;
  tokenHash: string | null;
  csrfSecret: string | null;
  pairedAt: number | null;
  expiresAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  staffId: string | null;
  staffSince: number | null;
  staffSeenAt: number | null;
  updatedAt: number;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  kind: 'device' | 'terminal';
  name: string;
  event_id: string | null;
  settings: string;
  time_zone: string;
  token_prefix: string | null;
  token_hash: string | null;
  csrf_secret: string | null;
  paired_at: number | null;
  expires_at: number | null;
  last_seen_at: number | null;
  revoked_at: number | null;
  staff_id: string | null;
  staff_since: number | null;
  staff_seen_at: number | null;
  updated_at: number;
}

const COLUMNS = `id, org_id, mode, kind, name, event_id, settings, time_zone, token_prefix, token_hash,
  csrf_secret, paired_at, expires_at, last_seen_at, revoked_at, staff_id, staff_since, staff_seen_at, updated_at`;

const toRow = (r: Raw): ScannerRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  kind: r.kind,
  name: r.name,
  eventId: r.event_id,
  settings: r.settings,
  timeZone: r.time_zone,
  tokenPrefix: r.token_prefix,
  tokenHash: r.token_hash,
  csrfSecret: r.csrf_secret,
  pairedAt: r.paired_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at,
  staffId: r.staff_id,
  staffSince: r.staff_since,
  staffSeenAt: r.staff_seen_at,
  updatedAt: r.updated_at,
});

export async function getScannerByPrefix(db: Db, prefix: string): Promise<ScannerRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scanners WHERE token_prefix = ?`, [
    prefix,
  ]);
  return row ? toRow(row) : null;
}

export async function getScanner(db: Db, id: string): Promise<ScannerRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scanners WHERE id = ?`, [id]);
  return row ? toRow(row) : null;
}

/** Writes only when the last touch is older than `everyMs`, so a busy door costs one write a minute. */
export async function touchScanner(
  db: Db,
  id: string,
  now: number,
  ipPrefix: string | null,
  everyMs: number,
): Promise<void> {
  await run(
    db,
    `UPDATE scanners SET last_seen_at = ?, last_ip_prefix = ?
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)`,
    [now, ipPrefix, id, now - everyMs],
  );
}

export async function bindStaff(db: Db, id: string, staffId: string, now: number): Promise<void> {
  await run(
    db,
    'UPDATE scanners SET staff_id = ?, staff_since = ?, staff_seen_at = ? WHERE id = ?',
    [staffId, now, now, id],
  );
}

export async function unbindStaff(db: Db, id: string): Promise<void> {
  await run(
    db,
    'UPDATE scanners SET staff_id = NULL, staff_since = NULL, staff_seen_at = NULL WHERE id = ?',
    [id],
  );
}

export async function touchStaff(db: Db, id: string, now: number, everyMs: number): Promise<void> {
  await run(
    db,
    `UPDATE scanners SET staff_seen_at = ?
     WHERE id = ? AND staff_id IS NOT NULL AND staff_seen_at <= ?`,
    [now, id, now - everyMs],
  );
}
