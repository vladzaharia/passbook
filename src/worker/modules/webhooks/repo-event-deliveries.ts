import { all, first } from '../../platform/db.ts';
import type { DeliveryRow, DeliveryState } from './repo-api.ts';
import type { FeedFence } from './repo-feed.ts';

export interface EventDeliveryRow extends DeliveryRow {
  endpointId: string;
  target: 'url' | 'capture';
}

interface Raw {
  endpoint_id: string;
  target: 'url' | 'capture';
  event_seq: number;
  event_id: string;
  type: string;
  pass_id: string;
  external_id: string | null;
  state: DeliveryState;
  attempts: number;
  next_at: number;
  last_status: number | null;
  last_error: string | null;
  last_attempt_at: number | null;
  finished_at: number | null;
  replays: number;
}

/** Every endpoint's delivery of one event, in the fenced org and mode, a quarantined pass's rows hidden as in the feed. */
export async function listEventDeliveries(
  db: D1Database,
  fence: FeedFence,
  eventId: string,
): Promise<EventDeliveryRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT d.endpoint_id, e.target, d.event_seq, f.event_id, f.type, f.pass_id, f.external_id, d.state,
       d.attempts, d.next_at, d.last_status, d.last_error, d.last_attempt_at, d.finished_at, d.replays
     FROM webhook_deliveries d
     JOIN event_feed f ON f.seq = d.event_seq AND f.org_id = d.org_id AND f.mode = d.mode
     JOIN passes p ON p.id = f.pass_id AND p.org_id = f.org_id AND p.mode = f.mode
       AND p.test_data_quarantined = 0
     JOIN webhook_endpoints e ON e.id = d.endpoint_id AND e.org_id = d.org_id AND e.mode = d.mode
     WHERE f.event_id = ? AND d.org_id = ? AND d.mode = ?
     ORDER BY e.target = 'capture' DESC, d.endpoint_id LIMIT 100`,
    [eventId, fence.orgId, fence.mode],
  );
  return rows.map((r) => ({
    endpointId: r.endpoint_id,
    target: r.target,
    eventSeq: r.event_seq,
    eventId: r.event_id,
    type: r.type,
    passId: r.pass_id,
    externalId: r.external_id,
    state: r.state,
    attempts: r.attempts,
    nextAt: r.next_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastAttemptAt: r.last_attempt_at,
    finishedAt: r.finished_at,
    replays: r.replays,
  }));
}

/** Failed deliveries of the org's Test endpoints that finished after `since`. */
export async function countFailedDeliveries(
  db: D1Database,
  orgId: string,
  since: number,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM webhook_deliveries d
     JOIN event_feed f ON f.seq = d.event_seq AND f.org_id = d.org_id AND f.mode = d.mode
     JOIN passes p ON p.id = f.pass_id AND p.org_id = f.org_id AND p.mode = f.mode
       AND p.test_data_quarantined = 0
     WHERE d.org_id = ? AND d.mode = 'test' AND d.state = 'failed' AND d.finished_at > ?`,
    [orgId, since],
  );
  return row?.n ?? 0;
}
