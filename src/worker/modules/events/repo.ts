import type { Mode } from '../../../shared/contracts/common.ts';
import type { EventKind } from '../../../shared/contracts/events.ts';
import { all, run, stmt } from '../../platform/db.ts';

export interface EventRow {
  id: string;
  org_id: string;
  pass_id: string;
  mode: Mode;
  kind: EventKind;
  device: string | null;
  actor_type: string | null;
  actor_id: string | null;
  data: string;
  at: number;
}

export function insertEventStmt(db: D1Database, row: EventRow): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.org_id,
      row.pass_id,
      row.mode,
      row.kind,
      row.device,
      row.actor_type,
      row.actor_id,
      row.data,
      row.at,
    ],
  );
}

export interface EventFilter {
  passId: string;
  kinds?: readonly EventKind[];
  /** The last event of the previous page. */
  after?: { at: number; id: string };
  limit: number;
}

/** Newest first. The (pass_id, at) index serves the order; id breaks ties. */
export function listEvents(db: D1Database, f: EventFilter): Promise<EventRow[]> {
  const where = ['pass_id = ?'];
  const params: (string | number)[] = [f.passId];
  if (f.kinds?.length) {
    where.push(`kind IN (${f.kinds.map(() => '?').join(', ')})`);
    params.push(...f.kinds);
  }
  if (f.after) {
    where.push('(at < ? OR (at = ? AND id < ?))');
    params.push(f.after.at, f.after.at, f.after.id);
  }
  return all<EventRow>(
    db,
    `SELECT * FROM pass_events WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`,
    [...params, f.limit],
  );
}

/** Deletes up to `limit` rows older than `cutoff`; returns how many. */
export async function deleteEventsBefore(
  db: D1Database,
  cutoff: number,
  limit: number,
): Promise<number> {
  const { changes } = await run(
    db,
    'DELETE FROM pass_events WHERE id IN (SELECT id FROM pass_events WHERE at < ? LIMIT ?)',
    [cutoff, limit],
  );
  return changes;
}

export interface LatestDeviceEvent {
  device: string;
  kind: EventKind;
  at: number;
  data: string;
}

/**
 * The newest event per (device, kind, step) of a pass, for the kinds that decide a device's state.
 * `step` separates a device's "asked for updates" check-in from its pass-file fetch.
 */
export function latestDeviceEvents(db: D1Database, passId: string): Promise<LatestDeviceEvent[]> {
  return all<LatestDeviceEvent>(
    db,
    `SELECT device, kind, at, data FROM (
       SELECT device, kind, at, data, ROW_NUMBER() OVER (
         PARTITION BY device, kind, COALESCE(json_extract(data, '$.step'), '')
         ORDER BY at DESC, id DESC) AS rn
       FROM pass_events
       WHERE pass_id = ? AND device IS NOT NULL
         AND kind IN ('device.registered', 'device.unregistered', 'device.fetched', 'push.sent', 'push.failed'))
     WHERE rn = 1`,
    [passId],
  );
}

/** Registrations of a pass: raw device ids, which only this layer may hash. */
export function registrationsOfPass(
  db: D1Database,
  passId: string,
): Promise<{ device_id: string; created_at: number }[]> {
  return all(db, 'SELECT device_id, created_at FROM registrations WHERE pass_id = ?', [passId]);
}

/** The earliest device that checked in since `since` and has not fetched the file after it. */
export async function pendingFetchDevices(
  db: D1Database,
  passId: string,
  since: number,
): Promise<string[]> {
  const rows = await all<{ device: string }>(
    db,
    `SELECT l.device FROM pass_events l
     WHERE l.pass_id = ? AND l.kind = 'device.fetched' AND l.at >= ?
       AND json_extract(l.data, '$.step') = 'listed' AND l.device IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pass_events f
         WHERE f.pass_id = l.pass_id AND f.device = l.device AND f.kind = 'device.fetched'
           AND json_extract(f.data, '$.step') = 'file' AND f.at >= l.at)
     ORDER BY l.at, l.id LIMIT 1`,
    [passId, since],
  );
  return rows.map((r) => r.device);
}
