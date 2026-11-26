import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
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
  /** The pass row is gone or soft-deleted. */
  passGone: boolean;
  orgActive: boolean;
  /** The org is a developer sandbox, read with the delivery so a send needs no query of its own. */
  sandbox: boolean;
}

interface DueRaw {
  attempts: number;
  replays: number;
  quarantined: number | null;
  pass_found: string | null;
  pass_deleted_at: number | null;
  org_status: string | null;
  org_kind: string | null;
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
    `SELECT d.attempts, d.replays, p.test_data_quarantined AS quarantined, p.id AS pass_found, p.deleted_at AS pass_deleted_at, o.status AS org_status, o.kind AS org_kind,
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
    passGone: r.pass_found === null || r.pass_deleted_at !== null,
    orgActive: r.org_status === 'active',
    sandbox: r.org_kind === 'developer',
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

/**
 * Active endpoints with a due delivery and a free lane, found through the due-by-time partial index.
 * A lane that is held (a queued or running handler) is skipped here, so a backed-up queue gets no
 * duplicate messages from the sweep.
 */
export async function listDueLanes(db: D1Database, now: number, limit: number): Promise<LaneKey[]> {
  const rows = await all<{ id: string; org_id: string; mode: Mode }>(
    db,
    `SELECT DISTINCT e.id, e.org_id, e.mode
     FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.endpoint_id AND e.org_id = d.org_id AND e.mode = d.mode
     WHERE d.state = 'pending' AND d.next_at <= ?
       AND e.status = 'active' AND (e.lane_until IS NULL OR e.lane_until < ?)
     LIMIT ?`,
    [now, now, limit],
  );
  return rows.map((r) => ({ endpointId: r.id, orgId: r.org_id, mode: r.mode }));
}

export interface DisabledEndpoint extends LaneKey {
  url: string;
  failingSince: number;
}

/** Active endpoints that have failed for 72 h with at least 10 failures in a row; one lane, or all. */
export async function overdueEndpoints(
  db: D1Database,
  now: number,
  only?: LaneKey,
): Promise<DisabledEndpoint[]> {
  const rows = await all<{
    id: string;
    org_id: string;
    mode: Mode;
    url: string;
    failing_since: number;
  }>(
    db,
    `SELECT id, org_id, mode, url, failing_since FROM webhook_endpoints
     WHERE status = 'active' AND failing_since IS NOT NULL AND failing_since <= ?
       AND consecutive_failures >= ? ${only ? 'AND id = ? AND org_id = ? AND mode = ?' : ''}
     LIMIT 100`,
    [
      now - DISABLE_AFTER_MS,
      DISABLE_AFTER_FAILURES,
      ...(only ? [only.endpointId, only.orgId, only.mode] : []),
    ],
  );
  return rows.map((r) => ({
    endpointId: r.id,
    orgId: r.org_id,
    mode: r.mode,
    url: r.url,
    failingSince: r.failing_since,
  }));
}

/** Whether any endpoint could be sending: the kick's cheap gate. */
export async function anyActiveEndpoint(db: D1Database): Promise<boolean> {
  return (
    (await first(db, "SELECT 1 FROM webhook_endpoints WHERE status = 'active' LIMIT 1")) !== null
  );
}
