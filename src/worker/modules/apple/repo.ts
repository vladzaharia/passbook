import { deleteInBatches } from '../../platform/batched.ts';
import { bump, prune } from '../../platform/counters.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';

export interface IdentityRef {
  id: string;
  nfcEnabled: boolean;
}

export async function identityByPassType(
  db: D1Database,
  passTypeId: string,
): Promise<IdentityRef | null> {
  const row = await first<{ id: string; nfc_enabled: number }>(
    db,
    'SELECT id, nfc_enabled FROM signing_identities WHERE pass_type_identifier = ?',
    [passTypeId],
  );
  return row ? { id: row.id, nfcEnabled: row.nfc_enabled === 1 } : null;
}

export async function registrationExists(
  db: D1Database,
  deviceId: string,
  identityId: string,
  passId: string,
): Promise<boolean> {
  const row = await first<{ n: number }>(
    db,
    'SELECT 1 AS n FROM registrations WHERE device_id = ? AND identity_id = ? AND pass_id = ?',
    [deviceId, identityId, passId],
  );
  return row !== null;
}

export async function registrationCount(db: D1Database, passId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM registrations WHERE pass_id = ?',
    [passId],
  );
  return row?.n ?? 0;
}

// One identity serves every org, so a device row is shared. A pass of org B must not redirect the
// pushes of a device that already holds passes of org A.
const NO_OTHER_ORG = `NOT EXISTS (SELECT 1 FROM registrations r JOIN passes p ON p.id = r.pass_id
  WHERE r.device_id = devices.device_id AND r.identity_id = devices.identity_id AND p.org_id <> ?)`;

/** Device and registration in one transaction; the `registrations_cap` trigger enforces the cap. */
export async function addRegistration(
  db: D1Database,
  r: {
    deviceId: string;
    identityId: string;
    passId: string;
    pushToken: string;
    now: number;
    orgId?: string;
  },
): Promise<void> {
  await batch(db, [
    stmt(
      db,
      `INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (device_id, identity_id) DO UPDATE SET push_token = excluded.push_token,
         updated_at = excluded.updated_at
       WHERE ${NO_OTHER_ORG}`,
      [r.deviceId, r.identityId, r.pushToken, r.now, r.orgId ?? ''],
    ),
    stmt(
      db,
      'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, ?)',
      [r.deviceId, r.identityId, r.passId, r.now],
    ),
  ]);
}

export async function updatePushToken(
  db: D1Database,
  deviceId: string,
  identityId: string,
  pushToken: string,
  now: number,
  orgId: string,
): Promise<void> {
  await run(
    db,
    `UPDATE devices SET push_token = ?, updated_at = ? WHERE device_id = ? AND identity_id = ?
     AND ${NO_OTHER_ORG}`,
    [pushToken, now, deviceId, identityId, orgId],
  );
}

export async function removeRegistration(
  db: D1Database,
  deviceId: string,
  identityId: string,
  passId: string,
): Promise<boolean> {
  const results = await batch(db, [
    stmt(db, 'DELETE FROM registrations WHERE device_id = ? AND identity_id = ? AND pass_id = ?', [
      deviceId,
      identityId,
      passId,
    ]),
    stmt(
      db,
      `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
       AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.device_id = ? AND r.identity_id = ?)`,
      [deviceId, identityId, deviceId, identityId],
    ),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function serialsSince(
  db: D1Database,
  deviceId: string,
  identityId: string,
  since: number,
  limit: number,
): Promise<{ serial: string; revision: number }[]> {
  return all<{ serial: string; revision: number }>(
    db,
    `SELECT p.serial, p.revision FROM registrations r JOIN passes p ON p.id = r.pass_id
     JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
     WHERE r.device_id = ? AND r.identity_id = ? AND p.revision > ? ORDER BY p.revision LIMIT ?`,
    [deviceId, identityId, since, limit],
  );
}

/** Adds `lines` to the hourly window and returns the new total. */
export const GLOBAL_LOG_KEY = 'apple.log';

export const bumpLogCounter = (db: D1Database, key: string, windowStart: number, lines: number) =>
  bump(db, key, windowStart, lines);

export async function insertLogs(
  db: D1Database,
  lines: string[],
  identityId: string | null,
  now: number,
): Promise<void> {
  await batch(
    db,
    lines.map((line) =>
      stmt(db, 'INSERT INTO wallet_logs (at, identity_id, line) VALUES (?, ?, ?)', [
        now,
        identityId,
        line,
      ]),
    ),
  );
}

export async function purgeLogs(db: D1Database, before: number): Promise<number> {
  const logs = await deleteInBatches(db, 'wallet_logs', 'at < ?', [before]);
  await prune(db, 'apple.log%', before);
  return logs;
}

export async function purgeRevisions(db: D1Database, before: number): Promise<number> {
  return deleteInBatches(db, 'revisions', 'at < ?', [before]);
}
