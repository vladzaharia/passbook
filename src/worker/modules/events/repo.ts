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

/** The organization and key-mode of the pass already authorized by the caller. */
export interface PassReadFence {
  orgId: string;
  mode: Mode | null;
}

const passReadFenceSql = `EXISTS (SELECT 1 FROM passes p
  WHERE p.id = ? AND p.org_id = ? AND (? IS NULL OR p.mode = ?)
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0)`;

function passReadFenceParams(passId: string, fence: PassReadFence) {
  return [passId, fence.orgId, fence.mode, fence.mode];
}

export interface EventFilter {
  passId: string;
  fence: PassReadFence;
  kinds?: readonly EventKind[];
  /** The last event of the previous page. */
  after?: { at: number; id: string };
  limit: number;
}

/** Newest first. The (pass_id, at) index serves the order; id breaks ties. */
export function listEvents(db: D1Database, f: EventFilter): Promise<EventRow[]> {
  const where = ['pass_id = ?', passReadFenceSql];
  const params: (string | number | null)[] = [f.passId, ...passReadFenceParams(f.passId, f.fence)];
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
export function latestDeviceEvents(
  db: D1Database,
  passId: string,
  fence: PassReadFence,
): Promise<LatestDeviceEvent[]> {
  return all<LatestDeviceEvent>(
    db,
    `SELECT device, kind, at, data FROM (
       SELECT device, kind, at, data, ROW_NUMBER() OVER (
         PARTITION BY device, kind, COALESCE(json_extract(data, '$.step'), '')
         ORDER BY at DESC, id DESC) AS rn
       FROM pass_events
       WHERE pass_id = ? AND device IS NOT NULL
         AND kind IN ('device.registered', 'device.unregistered', 'device.fetched', 'push.sent', 'push.failed')
         AND ${passReadFenceSql})
     WHERE rn = 1`,
    [passId, ...passReadFenceParams(passId, fence)],
  );
}

/** Registrations of a pass: raw device ids, which only this layer may hash. */
export function registrationsOfPass(
  db: D1Database,
  passId: string,
  fence: PassReadFence,
): Promise<{ device_id: string; created_at: number }[]> {
  return all(
    db,
    `SELECT device_id, created_at FROM registrations WHERE pass_id = ? AND ${passReadFenceSql}`,
    [passId, ...passReadFenceParams(passId, fence)],
  );
}
