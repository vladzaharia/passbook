import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all, first, placeholders, type SqlValue } from '../../platform/db.ts';
import type { DeliveryState } from './repo-api.ts';
import { assertOrgModeGrant } from './repo-endpoints.ts';
import type { FeedFence } from './repo-feed.ts';

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
  // A delivery that appeared meanwhile (a concurrent replay, the trigger) is skipped, not an abort.
  return g.upsert('webhook_deliveries', ['endpoint_id'], [endpointId], {
    doNothing: true,
    from: { table: 'event_feed', where: { seq: inList(seqs) }, copy: { event_seq: 'seq' } },
    returning: ['event_seq'],
  });
}

/**
 * Aborts the batch (`stale`) when this org and mode already committed a bulk replay since `since`.
 * Put first in the first chunk's grant: concurrent replays serialize on the batch, so only one writes.
 */
export function claimReplayMinute(g: Grant, since: number): void {
  assertOrgModeGrant(g);
  g.assert('stale', [
    tenantSql(
      `NOT EXISTS (SELECT 1 FROM audit_log prior WHERE prior.org_id = {org} AND prior.action = 'webhook.replay'
         AND prior.at > ? AND json_extract(prior.detail, '$.from') IS NOT NULL
         AND json_extract(prior.detail, '$.mode') = {mode})`,
      [since],
    ),
  ]);
}
