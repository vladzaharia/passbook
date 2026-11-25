import type { Mode } from '../../../shared/contracts/common.ts';
import { WebhookEventTypeSchema } from '../../../shared/contracts/webhooks.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { all, first, placeholders } from '../../platform/db.ts';
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
    requestId?: string | undefined;
    passId?: string | undefined;
    before?: number | undefined;
    limit: number;
  },
): Promise<{ rows: DeliveryRow[]; hasMore: boolean }> {
  const rows = await all<DeliveryRaw>(
    db,
    `SELECT ${DELIVERY_COLUMNS} FROM ${DELIVERY_FROM}
     WHERE d.endpoint_id = ? AND d.org_id = ? AND d.mode = ?
       ${q.state ? 'AND d.state = ?' : ''} ${q.type ? 'AND f.type = ?' : ''}
       ${q.requestId ? "AND json_extract(f.data, '$.requestId') = ?" : ''} ${q.passId ? 'AND f.pass_id = ?' : ''}
       ${q.before !== undefined ? 'AND d.event_seq < ?' : ''}
     ORDER BY d.event_seq DESC LIMIT ?`,
    [
      endpointId,
      fence.orgId,
      fence.mode,
      ...(q.state ? [q.state] : []),
      ...(q.type ? [q.type] : []),
      ...(q.requestId ? [q.requestId] : []),
      ...(q.passId ? [q.passId] : []),
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

export interface TestAttemptRow {
  id: string;
  type: string;
  status: number | null;
  errorCode: string | null;
  durationMs: number;
  at: number;
}

/** The newest "Send test" attempts of an endpoint: status, code and timing only; nothing of the request is kept. */
export async function listTestAttempts(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  limit: number,
): Promise<TestAttemptRow[]> {
  const rows = await all<{
    id: string;
    sample_type: string | null;
    status: number | null;
    error_code: string | null;
    duration_ms: number;
    at: number;
  }>(
    db,
    `SELECT id, sample_type, status, error_code, duration_ms, at FROM webhook_attempts
     WHERE endpoint_id = ? AND org_id = ? AND mode = ? AND event_seq IS NULL AND trigger = 'test'
     ORDER BY at DESC, rowid DESC LIMIT ?`,
    [endpointId, fence.orgId, fence.mode, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    type: WebhookEventTypeSchema.safeParse(r.sample_type).success
      ? (r.sample_type as string)
      : 'webhook.test',
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
    type: string;
    status: number | null;
    errorCode: string | null;
    durationMs: number;
    at: number;
  },
): GrantedStatement {
  assertOrgModeGrant(g);
  return g.insertSelect(
    'webhook_attempts',
    ['id', 'attempt', 'trigger', 'sample_type', 'status', 'error_code', 'duration_ms', 'at'],
    [a.id, 1, 'test', a.type, a.status, a.errorCode, a.durationMs, a.at],
    {
      from: {
        table: 'webhook_endpoints',
        where: { id: a.endpointId },
        copy: { endpoint_id: 'id' },
      },
    },
  );
}

/** Endpoint creates of the org since `since`: counted from the audit log, so a delete does not reset it. */
export async function countRecentCreates(
  db: D1Database,
  orgId: string,
  since: number,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = 'webhook.endpoint.create' AND at > ?",
    [orgId, since],
  );
  return row?.n ?? 0;
}

/** A replay audit row of this endpoint since `since`, so single replays log once a minute. */
export async function hasRecentReplayAudit(
  db: D1Database,
  orgId: string,
  endpointId: string,
  since: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      "SELECT 1 FROM audit_log WHERE org_id = ? AND action = 'webhook.replay' AND target_id = ? AND at > ? LIMIT 1",
      [orgId, endpointId, since],
    )) !== null
  );
}

/** A bulk replay (its audit row carries `from`) of this org and mode since `since`. */
export async function hasRecentBulkReplay(
  db: D1Database,
  orgId: string,
  mode: string,
  since: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      "SELECT 1 FROM audit_log WHERE org_id = ? AND action = 'webhook.replay' AND at > ? AND json_extract(detail, '$.from') IS NOT NULL AND json_extract(detail, '$.mode') = ? LIMIT 1",
      [orgId, since, mode],
    )) !== null
  );
}
