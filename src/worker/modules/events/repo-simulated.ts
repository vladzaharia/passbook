import { all, first, run } from '../../platform/db.ts';

export interface SimulatedDeviceRow {
  id: string;
  created_at: number;
  removed_at: number | null;
}

export async function insertSimulatedDevice(
  db: D1Database,
  row: { id: string; orgId: string; passId: string; at: number },
): Promise<void> {
  await run(
    db,
    'INSERT INTO pass_simulated_devices (id, org_id, pass_id, created_at) VALUES (?, ?, ?, ?)',
    [row.id, row.orgId, row.passId, row.at],
  );
}

/** Newest first. Rows of a pass outside the org never match. */
export function simulatedDevicesOfPass(
  db: D1Database,
  passId: string,
  orgId: string,
): Promise<SimulatedDeviceRow[]> {
  return all<SimulatedDeviceRow>(
    db,
    `SELECT id, created_at, removed_at FROM pass_simulated_devices
     WHERE pass_id = ? AND org_id = ? ORDER BY created_at DESC, id DESC`,
    [passId, orgId],
  );
}

export function getSimulatedDevice(
  db: D1Database,
  id: string,
  passId: string,
  orgId: string,
): Promise<SimulatedDeviceRow | null> {
  return first<SimulatedDeviceRow>(
    db,
    `SELECT id, created_at, removed_at FROM pass_simulated_devices
     WHERE id = ? AND pass_id = ? AND org_id = ?`,
    [id, passId, orgId],
  );
}

/** True when this call removed it. */
export async function removeSimulatedDevice(
  db: D1Database,
  id: string,
  passId: string,
  orgId: string,
  at: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_simulated_devices SET removed_at = ?
     WHERE id = ? AND pass_id = ? AND org_id = ? AND removed_at IS NULL`,
    [at, id, passId, orgId],
  );
  return changes > 0;
}

/** The outbox row of the pass's newest Test-inbox message. */
export async function latestCapturedOutbox(
  db: D1Database,
  passId: string,
  orgId: string,
): Promise<string | null> {
  const row = await first<{ outbox_id: string }>(
    db,
    `SELECT outbox_id FROM captured_emails
     WHERE pass_id = ? AND org_id = ? AND outbox_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [passId, orgId],
  );
  return row?.outbox_id ?? null;
}

export async function eventStored(db: D1Database, eventId: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS present FROM pass_events WHERE id = ?', [eventId])) !== null;
}
