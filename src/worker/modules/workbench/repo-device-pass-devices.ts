import { all, first, run } from '../../platform/db.ts';

export interface DevicePassDeviceRow {
  device_id: string;
  push_token: string;
  created_at: number;
}

export type DeviceAdd = 'added' | 'known' | 'over';

/**
 * A phone registers: a live one keeps its row (new token), a removed one that comes back is re-added without
 * counting again, and a new one is added only while the pass has had fewer than `max` phones in all.
 */
export async function addDevice(
  db: D1Database,
  r: { devicePassId: string; deviceId: string; pushToken: string; now: number; max: number },
): Promise<DeviceAdd> {
  const known = await run(
    db,
    `UPDATE device_pass_devices SET push_token = ?
     WHERE device_pass_id = ? AND device_id = ? AND removed_at IS NULL`,
    [r.pushToken, r.devicePassId, r.deviceId],
  );
  if (known.changes > 0) return 'known';
  const back = await run(
    db,
    `UPDATE device_pass_devices SET push_token = ?, removed_at = NULL
     WHERE device_pass_id = ? AND device_id = ?`,
    [r.pushToken, r.devicePassId, r.deviceId],
  );
  if (back.changes > 0) return 'added';
  const { changes } = await run(
    db,
    `INSERT INTO device_pass_devices (device_pass_id, device_id, push_token, created_at)
     SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM device_pass_devices WHERE device_pass_id = ?) < ?`,
    [r.devicePassId, r.deviceId, r.pushToken, r.now, r.devicePassId, r.max],
  );
  return changes > 0 ? 'added' : 'over';
}

export async function removeDevice(
  db: D1Database,
  devicePassId: string,
  deviceId: string,
  now: number,
) {
  const { changes } = await run(
    db,
    `UPDATE device_pass_devices SET removed_at = ?
     WHERE device_pass_id = ? AND device_id = ? AND removed_at IS NULL`,
    [now, devicePassId, deviceId],
  );
  return changes > 0;
}

export const devicesOf = (db: D1Database, devicePassId: string) =>
  all<DevicePassDeviceRow>(
    db,
    'SELECT device_id, push_token, created_at FROM device_pass_devices WHERE device_pass_id = ? AND removed_at IS NULL',
    [devicePassId],
  );

/** The device passes a phone holds that changed after its tag: (id, tag), oldest first. */
export const changedSince = (db: D1Database, deviceId: string, since: number, limit: number) =>
  all<{ id: string; state: string; updated_at: number }>(
    db,
    `SELECT d.id, d.state, d.updated_at FROM device_passes d
       JOIN device_pass_devices x ON x.device_pass_id = d.id
     WHERE x.device_id = ? AND x.removed_at IS NULL AND d.updated_at > ? ORDER BY d.updated_at LIMIT ?`,
    [deviceId, since, limit],
  );

/** Phones of a source pass's device passes still registered, for the pass's devices view. */
export const devicesOfPass = (db: D1Database, passId: string) =>
  all<{ device_id: string; created_at: number; updated_at: number; last_seen_at: number | null }>(
    db,
    `SELECT x.device_id, x.created_at, d.updated_at, d.last_seen_at FROM device_pass_devices x
       JOIN device_passes d ON d.id = x.device_pass_id
     WHERE d.pass_id = ? AND d.state IN ('pending', 'active') AND x.removed_at IS NULL`,
    [passId],
  );

export async function isBlocked(db: D1Database, userId: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS n FROM device_pass_blocks WHERE user_id = ?', [userId])) !== null
  );
}

export async function blockUser(db: D1Database, userId: string, now: number): Promise<void> {
  await run(
    db,
    `INSERT INTO device_pass_blocks (user_id, reason, created_at) VALUES (?, 'overshared', ?)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, now],
  );
}

export async function unblockUser(db: D1Database, userId: string): Promise<boolean> {
  const { changes } = await run(db, 'DELETE FROM device_pass_blocks WHERE user_id = ?', [userId]);
  return changes > 0;
}
