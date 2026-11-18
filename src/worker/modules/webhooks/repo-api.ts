import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all, first, placeholders, type SqlValue } from '../../platform/db.ts';
import type { FeedRow } from './payload.ts';
import { assertOrgModeGrant } from './repo-endpoints.ts';
import { type FeedFence, feedRowOf } from './repo-feed.ts';

/** How many of the given template ids belong to the org: a filter may name the org's own templates only. */
export async function countOrgTemplates(
  db: D1Database,
  orgId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM templates WHERE org_id = ? AND id IN (${placeholders(ids.length)})`,
    [orgId, ...ids],
  );
  return row?.n ?? 0;
}

export type DeliveryState = 'pending' | 'delivered' | 'failed' | 'cancelled';

export interface DeliveryRow {
  eventSeq: number;
  eventId: string;
  type: string;
  passId: string;
  externalId: string | null;
  state: DeliveryState;
  attempts: number;
  nextAt: number;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptAt: number | null;
  finishedAt: number | null;
  replays: number;
}

interface DeliveryRaw {
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

const DELIVERY_COLUMNS = `d.event_seq, f.event_id, f.type, f.pass_id, f.external_id, d.state, d.attempts,
  d.next_at, d.last_status, d.last_error, d.last_attempt_at, d.finished_at, d.replays`;

/** A delivery with its feed row; a quarantined pass's rows are hidden, as in the feed. */
const DELIVERY_FROM = `webhook_deliveries d
  JOIN event_feed f ON f.seq = d.event_seq AND f.org_id = d.org_id AND f.mode = d.mode
  JOIN passes p ON p.id = f.pass_id AND p.org_id = f.org_id AND p.mode = f.mode
    AND p.test_data_quarantined = 0`;

const deliveryOf = (r: DeliveryRaw): DeliveryRow => ({
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
});

/** Newest first; one extra row tells the caller whether another page exists. */
export async function listDeliveries(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  q: {
    state?: DeliveryState | undefined;
    type?: string | undefined;
    before?: number | undefined;
    limit: number;
  },
): Promise<{ rows: DeliveryRow[]; hasMore: boolean }> {
  const rows = await all<DeliveryRaw>(
    db,
    `SELECT ${DELIVERY_COLUMNS} FROM ${DELIVERY_FROM}
     WHERE d.endpoint_id = ? AND d.org_id = ? AND d.mode = ?
       ${q.state ? 'AND d.state = ?' : ''} ${q.type ? 'AND f.type = ?' : ''}
       ${q.before !== undefined ? 'AND d.event_seq < ?' : ''}
     ORDER BY d.event_seq DESC LIMIT ?`,
    [
      endpointId,
      fence.orgId,
      fence.mode,
      ...(q.state ? [q.state] : []),
      ...(q.type ? [q.type] : []),
      ...(q.before !== undefined ? [q.before] : []),
      q.limit + 1,
    ],
  );
  return { rows: rows.slice(0, q.limit).map(deliveryOf), hasMore: rows.length > q.limit };
}

interface FeedJoinRaw extends DeliveryRaw {
  seq: number;
  org_id: string;
  mode: Mode;
  template_id: string;
  kind: string;
  device: string | null;
  device_count: number | null;
  actor_type: string | null;
  data: string;
  at: number;
}

/** One delivery by the event's ledger id, with the feed row the payload is rebuilt from. */
export async function getDelivery(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  eventId: string,
): Promise<{ delivery: DeliveryRow; feed: FeedRow } | null> {
  const r = await first<FeedJoinRaw>(
    db,
    `SELECT ${DELIVERY_COLUMNS}, f.seq, f.org_id, f.mode, f.template_id, f.kind, f.device,
       f.device_count, f.actor_type, f.data, f.at
     FROM ${DELIVERY_FROM}
     WHERE d.endpoint_id = ? AND d.org_id = ? AND d.mode = ? AND f.event_id = ?`,
    [endpointId, fence.orgId, fence.mode, eventId],
  );
  if (!r) return null;
  return {
    delivery: deliveryOf(r),
    feed: feedRowOf({
      seq: r.seq,
      event_id: r.event_id,
      org_id: r.org_id,
      mode: r.mode,
      pass_id: r.pass_id,
      template_id: r.template_id,
      external_id: r.external_id,
      type: r.type,
      kind: r.kind,
      device: r.device,
      device_count: r.device_count,
      actor_type: r.actor_type,
      data: r.data,
      at: r.at,
    }),
  };
}

export interface AttemptRow {
  attempt: number;
  trigger: 'event' | 'retry' | 'replay' | 'test';
  status: number | null;
  errorCode: string | null;
  durationMs: number;
  at: number;
}

export async function listAttempts(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  eventSeq: number,
): Promise<AttemptRow[]> {
  const rows = await all<{
    attempt: number;
    trigger: AttemptRow['trigger'];
    status: number | null;
    error_code: string | null;
    duration_ms: number;
    at: number;
  }>(
    db,
    `SELECT attempt, trigger, status, error_code, duration_ms, at FROM webhook_attempts
     WHERE endpoint_id = ? AND event_seq = ? AND org_id = ? AND mode = ?
     ORDER BY at, attempt LIMIT 200`,
    [endpointId, eventSeq, fence.orgId, fence.mode],
  );
  return rows.map((r) => ({
    attempt: r.attempt,
    trigger: r.trigger,
    status: r.status,
    errorCode: r.error_code,
    durationMs: r.duration_ms,
    at: r.at,
  }));
}

/** The "Send test" attempt: no feed row, so it counts toward no delivery and no endpoint health. */
export function insertTestAttempt(
  g: Grant,
  a: {
    id: string;
    endpointId: string;
    status: number | null;
    errorCode: string | null;
    durationMs: number;
    at: number;
  },
): GrantedStatement {
  assertOrgModeGrant(g);
  return g.insertSelect(
    'webhook_attempts',
    ['id', 'attempt', 'trigger', 'status', 'error_code', 'duration_ms', 'at'],
    [a.id, 1, 'test', a.status, a.errorCode, a.durationMs, a.at],
    {
      from: {
        table: 'webhook_endpoints',
        where: { id: a.endpointId },
        copy: { endpoint_id: 'id' },
      },
    },
  );
}

/** What a bulk replay covers: events inside the window, in the given delivery states. */
export interface ReplayWindow {
  from: number;
  to: number;
  states: readonly DeliveryState[];
}

/** Deliveries a bulk replay would reset; the service refuses a window over the cap before writing. */
export async function countReplayable(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  w: ReplayWindow,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM webhook_deliveries d
     JOIN event_feed f ON f.seq = d.event_seq AND f.org_id = d.org_id AND f.mode = d.mode
     WHERE d.endpoint_id = ? AND d.org_id = ? AND d.mode = ? AND d.state IN (${placeholders(w.states.length)})
       AND f.at >= ? AND f.at <= ?`,
    [endpointId, fence.orgId, fence.mode, ...w.states, w.from, w.to],
  );
  return row?.n ?? 0;
}

/** Feed events in the window that match the endpoint's subscription and have no delivery to it yet. */
export async function missingSeqs(
  db: D1Database,
  fence: FeedFence,
  endpoint: { id: string; eventTypes: readonly string[]; templateIds: readonly string[] | null },
  w: { from: number; to: number; limit: number },
): Promise<number[]> {
  const params: SqlValue[] = [fence.orgId, fence.mode, w.from, w.to, ...endpoint.eventTypes];
  const templates = endpoint.templateIds
    ? `AND f.template_id IN (${placeholders(endpoint.templateIds.length)})`
    : '';
  if (endpoint.templateIds) params.push(...endpoint.templateIds);
  params.push(endpoint.id, w.limit);
  const rows = await all<{ seq: number }>(
    db,
    `SELECT f.seq FROM event_feed f
     JOIN passes p ON p.id = f.pass_id AND p.org_id = f.org_id AND p.mode = f.mode
       AND p.test_data_quarantined = 0
     WHERE f.org_id = ? AND f.mode = ? AND f.at >= ? AND f.at <= ?
       AND f.type IN (${placeholders(endpoint.eventTypes.length)}) ${templates}
       AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id = ? AND d.event_seq = f.seq)
     ORDER BY f.seq LIMIT ?`,
    params,
  );
  return rows.map((r) => r.seq);
}

const RESET = { state: 'pending', attempts: 0, next_at: 0, finished_at: null } as const;

/** One delivery back to pending. A foreign or missing delivery aborts the batch (lineage). */
export function replayOne(g: Grant, endpointId: string, eventSeq: number): GrantedStatement {
  assertOrgModeGrant(g);
  return g.update('webhook_deliveries', {
    where: {
      endpoint_id: endpointId,
      event_seq: eventSeq,
      state: inList(['delivered', 'failed', 'cancelled']),
    },
    set: RESET,
    inc: ['replays'],
    require: 'one',
    returning: ['event_seq'],
  });
}

/**
 * Every delivery of the endpoint in the states and the event-time window, back to pending in one
 * statement. The window reads the feed row of the same tenant through `tenantSql`.
 */
export function replayWindow(g: Grant, endpointId: string, w: ReplayWindow): GrantedStatement {
  assertOrgModeGrant(g);
  return g.update('webhook_deliveries', {
    where: { endpoint_id: endpointId, state: inList([...w.states]) },
    set: RESET,
    inc: ['replays'],
    when: [
      tenantSql(
        `EXISTS (SELECT 1 FROM event_feed f WHERE f.seq = {row}.event_seq AND f.org_id = {org}
           AND f.mode = {mode} AND f.at >= ? AND f.at <= ?)`,
        [w.from, w.to],
      ),
    ],
    returning: ['event_seq'],
  });
}

/** New pending deliveries for feed events the endpoint never had; at most 20 events per statement. */
export function backfillDeliveries(g: Grant, endpointId: string, seqs: number[]): GrantedStatement {
  assertOrgModeGrant(g);
  return g.insertSelect('webhook_deliveries', ['endpoint_id'], [endpointId], {
    from: { table: 'event_feed', where: { seq: inList(seqs) }, copy: { event_seq: 'seq' } },
    returning: ['event_seq'],
  });
}
