import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run, stmt } from '../../platform/db.ts';
import type { FeedRow } from './payload.ts';
import { DISABLE_AFTER_FAILURES, DISABLE_AFTER_MS } from './schedule.ts';

/** An endpoint's lane identity: every state change is keyed by all three. */
export interface LaneKey {
  endpointId: string;
  orgId: string;
  mode: Mode;
}

export interface DeliveryKey extends LaneKey {
  eventSeq: number;
}

/** A pending delivery with the facts the sender re-checks before it POSTs. */
export interface DueDelivery {
  key: DeliveryKey;
  attempts: number;
  replays: number;
  feed: FeedRow;
  /** `passes.test_data_quarantined`; a pass quarantined after the event was written. */
  quarantined: boolean;
  orgActive: boolean;
}

interface DueRaw {
  attempts: number;
  replays: number;
  quarantined: number | null;
  org_status: string | null;
  seq: number;
  event_id: string;
  org_id: string;
  mode: Mode;
  pass_id: string;
  template_id: string;
  external_id: string | null;
  type: string;
  kind: string;
  device: string | null;
  device_count: number | null;
  actor_type: string | null;
  data: string;
  at: number;
}

/** The oldest due delivery of a lane. The feed row joins on all three keys; the pass and org are re-read. */
export async function nextDue(
  db: D1Database,
  lane: LaneKey,
  now: number,
): Promise<DueDelivery | null> {
  const r = await first<DueRaw>(
    db,
    `SELECT d.attempts, d.replays, p.test_data_quarantined AS quarantined, o.status AS org_status,
       f.seq, f.event_id, f.org_id, f.mode, f.pass_id, f.template_id, f.external_id, f.type, f.kind,
       f.device, f.device_count, f.actor_type, f.data, f.at
     FROM webhook_deliveries d
     JOIN event_feed f ON f.seq = d.event_seq AND f.org_id = d.org_id AND f.mode = d.mode
     LEFT JOIN passes p ON p.id = f.pass_id AND p.org_id = f.org_id AND p.mode = f.mode
     LEFT JOIN orgs o ON o.id = d.org_id
     WHERE d.endpoint_id = ? AND d.org_id = ? AND d.mode = ? AND d.state = 'pending' AND d.next_at <= ?
     ORDER BY d.next_at, d.event_seq LIMIT 1`,
    [lane.endpointId, lane.orgId, lane.mode, now],
  );
  if (!r) return null;
  return {
    key: { ...lane, eventSeq: r.seq },
    attempts: r.attempts,
    replays: r.replays,
    quarantined: r.quarantined !== 0,
    orgActive: r.org_status === 'active',
    feed: {
      seq: r.seq,
      eventId: r.event_id,
      orgId: r.org_id,
      mode: r.mode,
      passId: r.pass_id,
      templateId: r.template_id,
      externalId: r.external_id,
      type: r.type,
      kind: r.kind,
      device: r.device,
      deviceCount: r.device_count,
      actorType: r.actor_type,
      data: r.data,
      at: r.at,
    },
  };
}

/** Active endpoints with a due delivery and a free lane. Drives from the endpoints (a handful per org). */
export async function listDueLanes(db: D1Database, now: number, limit: number): Promise<LaneKey[]> {
  const rows = await all<{ id: string; org_id: string; mode: Mode }>(
    db,
    `SELECT e.id, e.org_id, e.mode FROM webhook_endpoints e
     WHERE e.status = 'active' AND (e.lane_until IS NULL OR e.lane_until < ?)
       AND EXISTS (SELECT 1 FROM webhook_deliveries d
         WHERE d.endpoint_id = e.id AND d.state = 'pending' AND d.next_at <= ?)
     LIMIT ?`,
    [now, now, limit],
  );
  return rows.map((r) => ({ endpointId: r.id, orgId: r.org_id, mode: r.mode }));
}

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

/** False once the lane is no longer ours (it expired and was claimed, or the endpoint was disabled). */
export async function extendLane(
  db: D1Database,
  lane: LaneKey,
  token: string,
  until: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE webhook_endpoints SET lane_until = ?
     WHERE id = ? AND org_id = ? AND mode = ? AND lane_token = ?`,
    [until, lane.endpointId, lane.orgId, lane.mode, token],
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

export interface DisabledEndpoint extends LaneKey {
  url: string;
  failingSince: number;
}

/**
 * Disables every active endpoint that has failed for 72 h with at least 10 failures in a row. The lane
 * is dropped with it, so a running handler stops at its next extension.
 */
export async function disableOverdue(db: D1Database, now: number): Promise<DisabledEndpoint[]> {
  const rows = await all<{
    id: string;
    org_id: string;
    mode: Mode;
    url: string;
    failing_since: number;
  }>(
    db,
    `UPDATE webhook_endpoints SET status = 'disabled', disabled_at = ?,
       lane_token = NULL, lane_until = NULL
     WHERE status = 'active' AND failing_since IS NOT NULL AND failing_since <= ?
       AND consecutive_failures >= ?
     RETURNING id, org_id, mode, url, failing_since`,
    [now, now - DISABLE_AFTER_MS, DISABLE_AFTER_FAILURES],
  );
  return rows.map((r) => ({
    endpointId: r.id,
    orgId: r.org_id,
    mode: r.mode,
    url: r.url,
    failingSince: r.failing_since,
  }));
}

/** Pending deliveries of a disabled endpoint end as cancelled. */
export function cancelPendingStmt(
  db: D1Database,
  lane: LaneKey,
  now: number,
  reason: string,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE webhook_deliveries SET state = 'cancelled', finished_at = ?, last_error = ?
     WHERE endpoint_id = ? AND org_id = ? AND mode = ? AND state = 'pending'`,
    [now, reason, lane.endpointId, lane.orgId, lane.mode],
  );
}

/** Whether any endpoint could be sending: the kick's cheap gate. */
export async function anyActiveEndpoint(db: D1Database): Promise<boolean> {
  return (
    (await first(db, "SELECT 1 FROM webhook_endpoints WHERE status = 'active' LIMIT 1")) !== null
  );
}
