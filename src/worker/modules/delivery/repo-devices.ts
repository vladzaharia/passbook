import { all, batch, chunk, first, run, stmt } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';

export interface RegistrationSnapshot {
  passId: string;
  credentialGeneration: number;
}

export interface DeviceTarget extends RegistrationSnapshot {
  deviceId: string;
  pushToken: string;
  /** Registrations sharing this token at the time the push was prepared. */
  registrations: RegistrationSnapshot[];
}

export interface PushFence extends RegistrationSnapshot {
  orgId: string;
  identityId: string;
  lifecycleGeneration: number;
  templateId: string;
  templateVersion: string;
  releaseId: string | null;
  outboxId: string;
  lease: string;
}

const pushFenceSql = `SELECT 1 FROM passes p
  JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
  JOIN outbox ob ON ob.pass_id = p.id AND ob.org_id = p.org_id
  WHERE p.id = ? AND p.org_id = ? AND p.identity_id = ? AND p.credential_generation = ?
    AND p.lifecycle_generation = ?
    AND p.template_id = ? AND p.template_version = ? AND p.release_id IS ?
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
    AND ob.id = ? AND ob.kind = 'push' AND ob.state = 'processing' AND ob.lease = ?
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
      WHERE t.pass_id = p.id AND t.state = 'pending')`;

const pushFenceParams = (f: PushFence) =>
  [
    f.passId,
    f.orgId,
    f.identityId,
    f.credentialGeneration,
    f.lifecycleGeneration,
    f.templateId,
    f.templateVersion,
    f.releaseId,
    f.outboxId,
    f.lease,
  ] as const;

export async function devicesForPass(
  db: D1Database,
  passId: string,
  identityId: string,
  credentialGeneration: number,
): Promise<DeviceTarget[]> {
  const rows = await all<{
    device_id: string;
    push_token: string;
    pass_id: string;
    credential_generation: number;
    shared_pass_id: string;
    shared_generation: number;
  }>(
    db,
    `SELECT r.device_id, COALESCE(r.push_token, d.push_token) AS push_token,
       r.pass_id, r.credential_generation, shared.pass_id AS shared_pass_id,
       shared.credential_generation AS shared_generation
     FROM registrations r
     JOIN devices d ON d.device_id = r.device_id AND d.identity_id = r.identity_id
     JOIN passes p ON p.id = r.pass_id AND p.identity_id = r.identity_id
       AND p.credential_generation = r.credential_generation
     JOIN registrations shared ON shared.device_id = r.device_id AND shared.identity_id = r.identity_id
       AND COALESCE(shared.push_token, d.push_token) = COALESCE(r.push_token, d.push_token)
     JOIN passes other ON other.id = shared.pass_id AND other.identity_id = shared.identity_id
       AND other.credential_generation = shared.credential_generation
     WHERE r.pass_id = ? AND r.identity_id = ? AND r.credential_generation = ?
       AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
       AND other.deleted_at IS NULL AND other.test_data_quarantined = 0
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending')
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = other.id AND t.state = 'pending')
     ORDER BY r.created_at`,
    [passId, identityId, credentialGeneration],
  );
  const devices = new Map<string, DeviceTarget>();
  for (const row of rows) {
    let device = devices.get(row.device_id);
    if (!device) {
      device = {
        deviceId: row.device_id,
        pushToken: row.push_token,
        passId: row.pass_id,
        credentialGeneration: row.credential_generation,
        registrations: [],
      };
      devices.set(row.device_id, device);
    }
    device.registrations.push({
      passId: row.shared_pass_id,
      credentialGeneration: row.shared_generation,
    });
  }
  return [...devices.values()];
}

/** Revalidate the captured incarnation and lease immediately before an external push. */
export async function pushPassCurrent(db: D1Database, fence: PushFence): Promise<boolean> {
  return (await first(db, pushFenceSql, pushFenceParams(fence))) !== null;
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
  pushToken: string;
  httpStatus: number | null;
  reason: string | null;
  apnsId: string | null;
}

export async function savePushResults(
  db: D1Database,
  fence: PushFence,
  rows: PushResultRow[],
  now: number,
): Promise<void> {
  await batch(
    db,
    rows.map((r) =>
      stmt(
        db,
        `INSERT OR REPLACE INTO push_results (outbox_id, device_id, http_status, reason, apns_id, at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (${pushFenceSql})
           AND EXISTS (SELECT 1 FROM registrations r JOIN devices d
             ON d.device_id = r.device_id AND d.identity_id = r.identity_id
             WHERE r.device_id = ? AND r.identity_id = ? AND r.pass_id = ?
               AND r.credential_generation = ? AND COALESCE(r.push_token, d.push_token) = ?)`,
        [
          fence.outboxId,
          r.deviceId,
          r.httpStatus,
          r.reason,
          r.apnsId,
          now,
          ...pushFenceParams(fence),
          r.deviceId,
          fence.identityId,
          fence.passId,
          fence.credentialGeneration,
          r.pushToken,
        ],
      ),
    ),
  );
}

/** Delivery events must commit against the same pass, release and lease as the push. */
export function pushEventStmt(
  db: D1Database,
  fence: PushFence,
  row: EventRow,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO pass_events
    (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${pushFenceSql})`,
    [
      row.id,
      fence.orgId,
      fence.passId,
      row.mode,
      row.kind,
      row.device,
      row.actor_type,
      row.actor_id,
      row.data,
      row.at,
      ...pushFenceParams(fence),
    ],
  );
}

/**
 * Remove only registrations that held the dead token in the original snapshot. A shared device
 * may have acquired another pass, or a pass may have transferred, while APNs was responding.
 */
export async function dropRegistrations(
  db: D1Database,
  fence: PushFence,
  dead: DeviceTarget[],
): Promise<void> {
  const targets = dead.filter(
    (d) => d.passId === fence.passId && d.credentialGeneration === fence.credentialGeneration,
  );
  const statements = [
    ...targets.flatMap((d) =>
      d.registrations.map((registration) =>
        stmt(
          db,
          `DELETE FROM registrations WHERE identity_id = ? AND device_id = ?
         AND pass_id = ? AND credential_generation = ?
         AND COALESCE(push_token, (SELECT push_token FROM devices
           WHERE device_id = registrations.device_id AND identity_id = registrations.identity_id)) = ?
         AND EXISTS (${pushFenceSql})
         AND EXISTS (SELECT 1 FROM passes current_pass
           WHERE current_pass.id = registrations.pass_id
             AND current_pass.identity_id = registrations.identity_id
             AND current_pass.credential_generation = registrations.credential_generation
             AND current_pass.deleted_at IS NULL AND current_pass.test_data_quarantined = 0
             AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
               WHERE t.pass_id = current_pass.id AND t.state = 'pending'))`,
          [
            fence.identityId,
            d.deviceId,
            registration.passId,
            registration.credentialGeneration,
            d.pushToken,
            ...pushFenceParams(fence),
          ],
        ),
      ),
    ),
    ...targets.map((d) =>
      stmt(
        db,
        `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
         AND NOT EXISTS (SELECT 1 FROM registrations r
           WHERE r.device_id = devices.device_id AND r.identity_id = devices.identity_id)
         AND EXISTS (${pushFenceSql})`,
        [d.deviceId, fence.identityId, ...pushFenceParams(fence)],
      ),
    ),
  ];
  for (const part of chunk(statements, 50)) await batch(db, part);
}

export async function setApnsHealth(
  db: D1Database,
  fence: PushFence,
  health: 'healthy' | 'failing',
): Promise<void> {
  await run(
    db,
    `UPDATE signing_identities SET apns_health = ?
    WHERE id = ? AND apns_health != ? AND EXISTS (${pushFenceSql})`,
    [health, fence.identityId, health, ...pushFenceParams(fence)],
  );
}

/** Settle only the worker's captured incarnation; a stale lease cannot finish a new delivery. */
export async function finishCurrentPush(
  db: D1Database,
  fence: PushFence,
  state: 'sent' | 'partial' | 'failed' | 'cancelled',
  now: number,
  errorCode: string | null,
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE outbox SET state = ?, lease = NULL, finished_at = ?,
    error_code = ?, provider_id = NULL, coalesce_key = NULL
    WHERE id = ? AND lease = ? AND EXISTS (${pushFenceSql})`,
    [state, now, errorCode, fence.outboxId, fence.lease, ...pushFenceParams(fence)],
  );
  return result.changes === 1;
}

export async function releaseCurrentPush(
  db: D1Database,
  fence: PushFence,
  retryAt: number,
  errorCode: string,
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE outbox SET state = 'enqueued', lease = NULL,
    enqueued_at = ?, error_code = ?
    WHERE id = ? AND lease = ? AND EXISTS (${pushFenceSql})`,
    [retryAt, errorCode, fence.outboxId, fence.lease, ...pushFenceParams(fence)],
  );
  return result.changes === 1;
}
