import { all, batch, run, stmt } from '../../platform/db.ts';

export interface DeviceTarget {
  deviceId: string;
  pushToken: string;
}

export async function devicesForPass(
  db: D1Database,
  passId: string,
  identityId: string,
): Promise<DeviceTarget[]> {
  const rows = await all<{ device_id: string; push_token: string }>(
    db,
    `SELECT d.device_id, d.push_token FROM registrations r
     JOIN devices d ON d.device_id = r.device_id AND d.identity_id = r.identity_id
     WHERE r.pass_id = ? AND r.identity_id = ? ORDER BY r.created_at`,
    [passId, identityId],
  );
  return rows.map((r) => ({ deviceId: r.device_id, pushToken: r.push_token }));
}

export async function deliveredDevices(db: D1Database, outboxId: string): Promise<Set<string>> {
  const rows = await all<{ device_id: string }>(
    db,
    'SELECT device_id FROM push_results WHERE outbox_id = ? AND http_status = 200',
    [outboxId],
  );
  return new Set(rows.map((r) => r.device_id));
}

export interface PushResultRow {
  deviceId: string;
  httpStatus: number | null;
  reason: string | null;
  apnsId: string | null;
}

export async function savePushResults(
  db: D1Database,
  outboxId: string,
  rows: PushResultRow[],
  now: number,
): Promise<void> {
  await batch(
    db,
    rows.map((r) =>
      stmt(
        db,
        `INSERT OR REPLACE INTO push_results (outbox_id, device_id, http_status, reason, apns_id, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [outboxId, r.deviceId, r.httpStatus, r.reason, r.apnsId, now],
      ),
    ),
  );
}

/**
 * A dead token belongs to the device, not the pass: remove the device and all its registrations
 * for this identity. Wallet registers again with a fresh token.
 */
export async function dropRegistrations(
  db: D1Database,
  identityId: string,
  deviceIds: string[],
): Promise<void> {
  await batch(db, [
    ...deviceIds.map((id) =>
      stmt(db, 'DELETE FROM registrations WHERE identity_id = ? AND device_id = ?', [
        identityId,
        id,
      ]),
    ),
    ...deviceIds.map((id) =>
      stmt(db, 'DELETE FROM devices WHERE device_id = ? AND identity_id = ?', [id, identityId]),
    ),
  ]);
}

export async function setApnsHealth(
  db: D1Database,
  identityId: string,
  health: 'healthy' | 'failing',
): Promise<void> {
  await run(db, 'UPDATE signing_identities SET apns_health = ? WHERE id = ? AND apns_health != ?', [
    health,
    identityId,
    health,
  ]);
}
