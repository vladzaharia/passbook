import { batch, run, stmt } from '../../platform/db.ts';
import type { DeliveryKey, DisabledEndpoint, LaneKey } from './repo-delivery-read.ts';
import { DISABLE_AFTER_FAILURES, DISABLE_AFTER_MS } from './schedule.ts';

/** True when this caller now holds the lane: a free lane of an active endpoint that has due work. */
export async function claimLane(
  db: D1Database,
  lane: LaneKey,
  token: string,
  now: number,
  holdMs: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE webhook_endpoints SET lane_token = ?, lane_until = ?
     WHERE id = ? AND org_id = ? AND mode = ? AND status = 'active'
       AND (lane_until IS NULL OR lane_until < ?)
       AND EXISTS (SELECT 1 FROM webhook_deliveries d
         WHERE d.endpoint_id = webhook_endpoints.id AND d.state = 'pending' AND d.next_at <= ?)`,
    [token, now + holdMs, lane.endpointId, lane.orgId, lane.mode, now, now],
  );
  return changes > 0;
}

/**
 * Moves the lane's expiry, and optionally swaps its token (`to`). A handler swaps the message's token for
 * a fresh one when it starts, so a redelivered copy of the same queue message finds the token gone and
 * stops. False once the lane is no longer `token`'s (expired and re-claimed, or the endpoint disabled).
 */
export async function extendLane(
  db: D1Database,
  lane: LaneKey,
  token: string,
  until: number,
  to: string = token,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE webhook_endpoints SET lane_until = ?, lane_token = ?
     WHERE id = ? AND org_id = ? AND mode = ? AND lane_token = ?`,
    [until, to, lane.endpointId, lane.orgId, lane.mode, token],
  );
  return changes > 0;
}

export async function releaseLane(db: D1Database, lane: LaneKey, token: string): Promise<void> {
  await run(
    db,
    `UPDATE webhook_endpoints SET lane_token = NULL, lane_until = NULL
     WHERE id = ? AND org_id = ? AND mode = ? AND lane_token = ?`,
    [lane.endpointId, lane.orgId, lane.mode, token],
  );
}

/**
 * Takes the attempt: a compare-and-swap on the count, with the next try parked `holdMs` out. A crash
 * after this point counts as an attempt and retries then. False when another runner got there first.
 */
export async function claimAttempt(
  db: D1Database,
  k: DeliveryKey,
  expected: number,
  now: number,
  holdMs: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE webhook_deliveries SET attempts = attempts + 1, next_at = ?, last_attempt_at = ?
     WHERE endpoint_id = ? AND event_seq = ? AND org_id = ? AND mode = ?
       AND state = 'pending' AND attempts = ?`,
    [now + holdMs, now, k.endpointId, k.eventSeq, k.orgId, k.mode, expected],
  );
  return changes > 0;
}

export interface AttemptRecord {
  id: string;
  attempt: number;
  trigger: 'event' | 'retry' | 'replay';
  status: number | null;
  errorCode: string | null;
  durationMs: number;
  at: number;
}

export function attemptStmt(db: D1Database, k: DeliveryKey, a: AttemptRecord): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO webhook_attempts (id, endpoint_id, org_id, mode, event_seq, attempt, trigger, status,
       error_code, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.id,
      k.endpointId,
      k.orgId,
      k.mode,
      k.eventSeq,
      a.attempt,
      a.trigger,
      a.status,
      a.errorCode,
      a.durationMs,
      a.at,
    ],
  );
}

/** A delivery reaches a final state: delivered, failed (the ninth try) or cancelled. */
export function finishStmt(
  db: D1Database,
  k: DeliveryKey,
  state: 'delivered' | 'failed' | 'cancelled',
  now: number,
  status: number | null,
  error: string | null,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE webhook_deliveries SET state = ?, finished_at = ?, last_status = ?, last_error = ?
     WHERE endpoint_id = ? AND event_seq = ? AND org_id = ? AND mode = ? AND state = 'pending'`,
    [state, now, status, error, k.endpointId, k.eventSeq, k.orgId, k.mode],
  );
}

export function rescheduleStmt(
  db: D1Database,
  k: DeliveryKey,
  nextAt: number,
  status: number | null,
  error: string | null,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE webhook_deliveries SET next_at = ?, last_status = ?, last_error = ?
     WHERE endpoint_id = ? AND event_seq = ? AND org_id = ? AND mode = ? AND state = 'pending'`,
    [nextAt, status, error, k.endpointId, k.eventSeq, k.orgId, k.mode],
  );
}

export function endpointSuccessStmt(
  db: D1Database,
  lane: LaneKey,
  now: number,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE webhook_endpoints SET last_success_at = ?, consecutive_failures = 0, failing_since = NULL
     WHERE id = ? AND org_id = ? AND mode = ?`,
    [now, lane.endpointId, lane.orgId, lane.mode],
  );
}

export function endpointFailureStmt(
  db: D1Database,
  lane: LaneKey,
  now: number,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1,
       failing_since = coalesce(failing_since, ?), last_failure_at = ?
     WHERE id = ? AND org_id = ? AND mode = ?`,
    [now, now, lane.endpointId, lane.orgId, lane.mode],
  );
}

/**
 * One batch: the guarded disable (the lane is dropped with it), the cancel of its pending deliveries and
 * the audit row, each of the last two conditional on this disable having happened. All or nothing.
 */
export async function disableEndpoint(
  db: D1Database,
  e: DisabledEndpoint,
  now: number,
  host: string,
): Promise<boolean> {
  const mine = `EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ? AND org_id = ? AND mode = ?
    AND status = 'disabled' AND disabled_at = ?)`;
  const key = [e.endpointId, e.orgId, e.mode];
  const [disabled] = await batch(db, [
    stmt(
      db,
      `UPDATE webhook_endpoints SET status = 'disabled', disabled_at = ?, lane_token = NULL, lane_until = NULL
       WHERE id = ? AND org_id = ? AND mode = ? AND status = 'active' AND failing_since IS NOT NULL
         AND failing_since <= ? AND consecutive_failures >= ?`,
      [now, ...key, now - DISABLE_AFTER_MS, DISABLE_AFTER_FAILURES],
    ),
    stmt(
      db,
      `UPDATE webhook_deliveries SET state = 'cancelled', finished_at = ?, last_error = 'ENDPOINT_DISABLED'
       WHERE endpoint_id = ? AND org_id = ? AND mode = ? AND state = 'pending' AND ${mine}`,
      [now, ...key, ...key, now],
    ),
    stmt(
      db,
      `INSERT INTO audit_log (at, org_id, actor_type, action, target_type, target_id, detail)
       SELECT ?, ?, 'system', 'webhook.endpoint_disabled', 'webhook_endpoint', ?,
         json_object('endpointId', ?, 'host', ?, 'failingSince', ?)
       WHERE ${mine} AND NOT EXISTS (SELECT 1 FROM audit_log
         WHERE action = 'webhook.endpoint_disabled' AND target_id = ? AND at = ?)`,
      [
        now,
        e.orgId,
        e.endpointId,
        e.endpointId,
        host,
        e.failingSince,
        ...key,
        now,
        e.endpointId,
        now,
      ],
    ),
  ]);
  return (disabled?.meta.changes ?? 0) > 0;
}

export interface CaptureRecord {
  id: string;
  eventId: string;
  eventType: string;
  trigger: 'event' | 'replay' | 'test';
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  at: number;
}

/**
 * A capture endpoint's "send": the signed request is stored, never sent. The triggers hold it to a capture
 * endpoint of its own org, 600 an hour per org and 200 per endpoint (the oldest are dropped), and the body
 * to 256 KiB.
 */
export function captureStmt(db: D1Database, lane: LaneKey, c: CaptureRecord): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO webhook_captures (id, endpoint_id, org_id, mode, event_id, event_type, trigger, headers, body,
       status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?)`,
    [
      c.id,
      lane.endpointId,
      lane.orgId,
      lane.mode,
      c.eventId,
      c.eventType,
      c.trigger,
      JSON.stringify(c.headers),
      c.body,
      c.durationMs,
      c.at,
    ],
  );
}
