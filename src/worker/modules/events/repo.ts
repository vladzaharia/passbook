import type { Mode } from '../../../shared/contracts/common.ts';
import type { EventKind } from '../../../shared/contracts/events.ts';
import { all, first, run, type SqlValue, stmt } from '../../platform/db.ts';

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

/**
 * The row's org comes from the pass: a pass of another org writes nothing (`changes` is 0), so the
 * caller can name the mismatch. A `live` event needs a live pass; a `test` event (a sandbox capture)
 * may sit on a pass of either mode.
 */
export function insertEventStmt(
  db: D1Database,
  row: EventRow,
  /** An extra condition on the insert, e.g. that the receipt it reports was stored. */
  guard?: { sql: string; params: SqlValue[] },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
     SELECT ?, p.org_id, p.id, ?, ?, ?, ?, ?, ?, ? FROM passes p
     WHERE p.id = ? AND p.org_id = ? AND (p.mode = ? OR ? = 'test')${guard ? ` AND ${guard.sql}` : ''}`,
    [
      row.id,
      row.mode,
      row.kind,
      row.device,
      row.actor_type,
      row.actor_id,
      row.data,
      row.at,
      row.pass_id,
      row.org_id,
      row.mode,
      row.mode,
      ...(guard?.params ?? []),
    ],
  );
}

/** The organization and key-mode of the pass already authorized by the caller. */
export interface PassReadFence {
  orgId: string;
  mode: Mode | null;
}

function passReadFenceSql(fence: PassReadFence): string {
  return `EXISTS (SELECT 1 FROM passes p
  WHERE p.id = ? AND p.org_id = ?${fence.mode === null ? '' : ' AND p.mode = ?'}
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0)`;
}

function passReadFenceParams(passId: string, fence: PassReadFence) {
  return fence.mode === null ? [passId, fence.orgId] : [passId, fence.orgId, fence.mode];
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
  const where = ['pass_id = ?', passReadFenceSql(f.fence)];
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

/** Deletes up to `limit` test-mode events older than `cutoff`; live events are deleted by the retention sweep. */
export async function deleteTestEventsBefore(
  db: D1Database,
  cutoff: number,
  limit: number,
): Promise<number> {
  const { changes } = await run(
    db,
    "DELETE FROM pass_events WHERE id IN (SELECT id FROM pass_events WHERE mode = 'test' AND at < ? LIMIT ?)",
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
         AND ${passReadFenceSql(fence)})
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
    `SELECT device_id, created_at FROM registrations WHERE pass_id = ? AND ${passReadFenceSql(fence)}`,
    [passId, ...passReadFenceParams(passId, fence)],
  );
}

/** Whether a pass row exists at all: tells a missing pass from one of another org or mode. */
export async function passExists(db: D1Database, passId: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS present FROM passes WHERE id = ?', [passId])) !== null;
}
