import { all, batch, first, run, stmt } from '../../platform/db.ts';

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
    `SELECT d.device_id, COALESCE(r.push_token, d.push_token) AS push_token FROM registrations r
     JOIN devices d ON d.device_id = r.device_id AND d.identity_id = r.identity_id
     JOIN passes p ON p.id = r.pass_id AND p.identity_id = r.identity_id
     WHERE r.pass_id = ? AND r.identity_id = ? AND p.deleted_at IS NULL
       AND p.test_data_quarantined = 0 ORDER BY r.created_at`,
    [passId, identityId],
  );
  return rows.map((r) => ({ deviceId: r.device_id, pushToken: r.push_token }));
}

/** Revalidate immediately before an external push, after all asynchronous preparation. */
export async function pushPassCurrent(
  db: D1Database,
  passId: string,
  orgId: string,
  identityId: string,
): Promise<boolean> {
  return (await first(
    db,
    `SELECT 1 FROM passes p JOIN orgs o ON o.id = p.org_id
     WHERE p.id = ? AND p.org_id = ? AND p.identity_id = ?
       AND p.deleted_at IS NULL AND p.test_data_quarantined = 0 AND o.status = 'active'`,
    [passId, orgId, identityId],
  )) !== null;
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
 * A dead token takes its registrations with it: every registration of that device that holds the
 * same token. Registrations with other tokens stay, so a bad token registered for one pass cannot
 * cost the device its other passes. Wallet registers again with a fresh token.
 */
export async function dropRegistrations(
  db: D1Database,
  identityId: string,
  dead: { deviceId: string; pushToken: string }[],
): Promise<void> {
  await batch(db, [
    ...dead.map((d) =>
      stmt(
        db,
        `DELETE FROM registrations WHERE identity_id = ? AND device_id = ?
         AND COALESCE(push_token, (SELECT push_token FROM devices
           WHERE device_id = registrations.device_id AND identity_id = registrations.identity_id)) = ?`,
        [identityId, d.deviceId, d.pushToken],
      ),
    ),
    ...dead.map((d) =>
      stmt(
        db,
        `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
         AND NOT EXISTS (SELECT 1 FROM registrations r
           WHERE r.device_id = devices.device_id AND r.identity_id = devices.identity_id)`,
        [d.deviceId, identityId],
      ),
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
