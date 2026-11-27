import { all, first, run } from '../../platform/db.ts';

export type DevicePassState = 'pending' | 'active' | 'voided' | 'expired';
export type DevicePassVoidReason =
  | 'developer'
  | 'expired'
  | 'overshared'
  | 'platform'
  | 'pass_gone';

export interface DevicePassRow {
  id: string;
  org_id: string;
  pass_id: string;
  user_id: string;
  state: DevicePassState;
  void_reason: DevicePassVoidReason | null;
  auth_nonce: string;
  code_expires_at: number | null;
  code_used_at: number | null;
  codes_issued: number;
  source_version: number;
  updated_at: number;
  created_at: number;
  expires_at: number;
  downloaded_at: number | null;
  last_seen_at: number | null;
  voided_at: number | null;
  device_count: number;
}

const COLUMNS = `d.id, d.org_id, d.pass_id, d.user_id, d.state, d.void_reason, d.auth_nonce, d.code_expires_at,
  d.code_used_at, d.codes_issued, d.source_version, d.updated_at, d.created_at, d.expires_at, d.downloaded_at,
  d.last_seen_at, d.voided_at,
  (SELECT count(*) FROM device_pass_devices x WHERE x.device_pass_id = d.id) AS device_count`;

export interface NewDevicePass {
  id: string;
  orgId: string;
  passId: string;
  userId: string;
  authNonce: string;
  codeHash: string;
  codeExpiresAt: number;
  againOf: string | null;
  sourceVersion: number;
  now: number;
  expiresAt: number;
  /** Pending and active passes the sandbox may hold. */
  cap: number;
}

/** False when the sandbox already holds `cap` open passes: counted in the same statement that inserts. */
export async function insertDevicePass(db: D1Database, n: NewDevicePass): Promise<boolean> {
  const { changes } = await run(
    db,
    `INSERT INTO device_passes (id, org_id, pass_id, user_id, state, auth_nonce, code_hash, code_expires_at,
       codes_issued, again_of, source_version, updated_at, created_at, expires_at)
     SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, 1, ?, ?, ?, ?, ?
     WHERE (SELECT count(*) FROM device_passes WHERE org_id = ? AND state IN ('pending', 'active')
       AND expires_at > ?) < ?`,
    [
      n.id,
      n.orgId,
      n.passId,
      n.userId,
      n.authNonce,
      n.codeHash,
      n.codeExpiresAt,
      n.againOf,
      n.sourceVersion,
      n.now,
      n.now,
      n.expiresAt,
      n.orgId,
      n.now,
      n.cap,
    ],
  );
  return changes > 0;
}

export const getDevicePass = (db: D1Database, id: string) =>
  first<DevicePassRow>(db, `SELECT ${COLUMNS} FROM device_passes d WHERE d.id = ?`, [id]);

export function listDevicePasses(db: D1Database, orgId: string, since: number, now: number) {
  return all<DevicePassRow>(
    db,
    `SELECT ${COLUMNS} FROM device_passes d WHERE d.org_id = ?
       AND (d.created_at >= ? OR (d.state IN ('pending', 'active') AND d.expires_at > ?))
     ORDER BY d.created_at DESC, d.id DESC LIMIT 50`,
    [orgId, since, now],
  );
}

export async function countOpen(db: D1Database, orgId: string, now: number): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM device_passes WHERE org_id = ? AND state IN ('pending', 'active')
       AND expires_at > ?`,
    [orgId, now],
  );
  return row?.n ?? 0;
}

export async function countCreatedSince(db: D1Database, userId: string, since: number) {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM device_passes WHERE user_id = ? AND created_at >= ?',
    [userId, since],
  );
  return row?.n ?? 0;
}

/** One winner per code: the row moves to active only while the code is unused, unexpired and the pass open. */
export async function consumeCode(db: D1Database, hash: string, now: number) {
  const rows = await all<{ id: string }>(
    db,
    `UPDATE device_passes SET state = 'active', code_used_at = ?, downloaded_at = COALESCE(downloaded_at, ?),
       last_seen_at = ?, updated_at = MAX(updated_at + 1, ?)
     WHERE code_hash = ? AND code_used_at IS NULL AND code_expires_at > ? AND state = 'pending'
       AND expires_at > ? RETURNING id`,
    [now, now, now, now, hash, now, now],
  );
  return rows[0]?.id ?? null;
}

/** A build that failed after the code was spent gives the code back: the phone never got the pass. */
export async function releaseCode(db: D1Database, id: string, now: number): Promise<void> {
  await run(
    db,
    `UPDATE device_passes SET state = 'pending', code_used_at = NULL, downloaded_at = NULL,
       updated_at = MAX(updated_at + 1, ?)
     WHERE id = ? AND state = 'active' AND code_used_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM device_pass_devices x WHERE x.device_pass_id = device_passes.id)`,
    [now, id],
  );
}

/** A new code for a pending pass; the old code stops working. False past 5 codes or once the pass left pending. */
export async function replaceCode(
  db: D1Database,
  r: { id: string; orgId: string; hash: string; codeExpiresAt: number; now: number },
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE device_passes SET code_hash = ?, code_expires_at = ?, codes_issued = codes_issued + 1
     WHERE id = ? AND org_id = ? AND state = 'pending' AND code_used_at IS NULL AND expires_at > ?
       AND codes_issued < 5`,
    [r.hash, r.codeExpiresAt, r.id, r.orgId, r.now],
  );
  return changes > 0;
}

/** Ends one open pass (the row it ended, or null when it was not open). The code dies with it. */
export async function endDevicePass(
  db: D1Database,
  id: string,
  reason: DevicePassVoidReason,
  now: number,
) {
  const rows = await all<{ id: string; org_id: string; pass_id: string }>(
    db,
    `UPDATE device_passes SET state = ?, void_reason = ?, voided_at = ?, code_hash = NULL,
       updated_at = MAX(updated_at + 1, ?)
     WHERE id = ? AND state IN ('pending', 'active') RETURNING id, org_id, pass_id`,
    [reason === 'expired' ? 'expired' : 'voided', reason, now, now, id],
  );
  return rows[0] ?? null;
}

/** Every open pass of one developer. */
export function endDevicePassesOf(
  db: D1Database,
  userId: string,
  reason: DevicePassVoidReason,
  now: number,
) {
  return all<{ id: string; org_id: string; pass_id: string }>(
    db,
    `UPDATE device_passes SET state = 'voided', void_reason = ?, voided_at = ?, code_hash = NULL,
       updated_at = MAX(updated_at + 1, ?)
     WHERE user_id = ? AND state IN ('pending', 'active') RETURNING id, org_id, pass_id`,
    [reason, now, now, userId],
  );
}

/** Open passes past their expiry, ended in the statement that finds them. */
export function expireDue(db: D1Database, now: number, limit: number) {
  return all<{ id: string; org_id: string; pass_id: string }>(
    db,
    `UPDATE device_passes SET state = 'expired', void_reason = 'expired', voided_at = ?, code_hash = NULL,
       updated_at = MAX(updated_at + 1, ?)
     WHERE id IN (SELECT id FROM device_passes WHERE state IN ('pending', 'active') AND expires_at <= ? LIMIT ?)
     RETURNING id, org_id, pass_id`,
    [now, now, now, limit],
  );
}

/** Rows and their devices go 30 days after the pass ended. */
export async function purgeEnded(db: D1Database, cutoff: number, limit: number): Promise<number> {
  const { changes } = await run(
    db,
    `DELETE FROM device_passes WHERE id IN (SELECT id FROM device_passes
       WHERE state IN ('voided', 'expired') AND expires_at < ? AND voided_at < ? LIMIT ?)`,
    [cutoff, cutoff, limit],
  );
  return changes;
}

/** Open passes of a source pass whose version moved: they now stand for it, and their tag moves. */
export function bumpForPass(db: D1Database, passId: string, version: number, now: number) {
  return all<{ id: string }>(
    db,
    `UPDATE device_passes SET source_version = ?, updated_at = MAX(updated_at + 1, ?)
     WHERE pass_id = ? AND state IN ('pending', 'active') AND source_version < ? RETURNING id`,
    [version, now, passId, version],
  );
}

/** Open passes the source pass left behind: its version moved, or it was voided, removed or deleted. */
export function staleOpenPasses(db: D1Database, limit: number) {
  return all<{ id: string; pass_id: string; version: number; gone: number }>(
    db,
    `SELECT d.id, d.pass_id, p.version,
       (p.deleted_at IS NOT NULL OR p.status != 'active' OR p.removed_at IS NOT NULL) AS gone
     FROM device_passes d JOIN passes p ON p.id = d.pass_id
     WHERE d.state IN ('pending', 'active')
       AND (p.version > d.source_version OR p.deleted_at IS NOT NULL OR p.status != 'active'
         OR p.removed_at IS NOT NULL)
     LIMIT ?`,
    [limit],
  );
}

/** A phone fetched the pass: when, and the hash of the pass.json that was signed for it. */
export async function markServed(
  db: D1Database,
  id: string,
  now: number,
  passJsonHash: string,
): Promise<void> {
  await run(db, 'UPDATE device_passes SET last_seen_at = ?, pass_json_hash = ? WHERE id = ?', [
    now,
    passJsonHash,
    id,
  ]);
}

export async function touchSeen(db: D1Database, id: string, now: number): Promise<void> {
  await run(db, 'UPDATE device_passes SET last_seen_at = ? WHERE id = ?', [now, id]);
}
