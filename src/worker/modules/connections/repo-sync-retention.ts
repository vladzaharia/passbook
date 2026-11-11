import { jobGrant } from '../../platform/authority.ts';
import { inList, lt, type WhereValue } from '../../platform/authority-expr.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { deleteRunsBefore } from '../../platform/workflow-runs.ts';
import { type ConnectionActor, commitOrNull, connectionGrant, plainWrite } from './repo-grants.ts';

// Retention

const PURPOSE = 'platform.job.connections_retention';
const IDS_PER_STATEMENT = 20;
const IDS_PER_PASS = 400;

const chunks = <T>(items: T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / IDS_PER_STATEMENT) }, (_, i) =>
    items.slice(i * IDS_PER_STATEMENT, (i + 1) * IDS_PER_STATEMENT),
  );

/**
 * Deletes `ids` of one retention table under a platform job grant, re-asserting `extra` on every row so
 * a row that changed since it was selected is left alone. Returns the rows deleted.
 */
async function deleteIds(
  ctx: ServiceContext,
  table: 'connection_runs' | 'connection_webhook_retention',
  ids: string[],
  extra: Record<string, WhereValue> = {},
): Promise<number> {
  if (ids.length === 0) return 0;
  const g = jobGrant(ctx, { purpose: PURPOSE, job: 'connection-retention' });
  for (const chunk of chunks(ids)) {
    const where = { id: inList(chunk), ...extra };
    if (table === 'connection_runs') g.joined(table, { delete: true, where, returning: ['id'] });
    else g.delete(table, { where, returning: ['id'] });
  }
  const results = await g.commit();
  return results.reduce((n, r) => n + r.results.length, 0);
}

export async function deleteOldRuns(
  ctx: ServiceContext,
  before: number,
  keep: number,
): Promise<number> {
  const g = jobGrant(ctx, { purpose: PURPOSE, job: 'connection-retention' });
  g.joined('connection_runs', {
    delete: true,
    where: { started_at: lt(before) },
    returning: ['id'],
  });
  const old = (await g.commit())[0]?.results.length ?? 0;
  // Only connections over the cap need ranking.
  const excess = await all<{ id: string }>(
    ctx.env.DB,
    `SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY connection_id ORDER BY started_at DESC, id DESC) AS rn
       FROM connection_runs
       WHERE connection_id IN (
         SELECT connection_id FROM connection_runs GROUP BY connection_id HAVING COUNT(*) > ?)
     ) WHERE rn > ? LIMIT ?`,
    [keep, keep, IDS_PER_PASS],
  );
  return (
    old +
    (await deleteIds(
      ctx,
      'connection_runs',
      excess.map((r) => r.id),
    ))
  );
}

export const deleteOldWorkflowRuns = (db: D1Database, before: number) =>
  deleteRunsBefore(db, 'connection_sync', before);

const FINISHED = `received_at < ? AND updated_at < ? AND state IN ('resolved', 'ignored')
     AND NOT EXISTS (SELECT 1 FROM webhook_events e
       WHERE e.connection_id = connection_webhook_retention.connection_id
         AND e.event_id = connection_webhook_retention.event_id)
     AND NOT EXISTS (SELECT 1 FROM connection_webhook_retention sibling
       WHERE sibling.connection_id = connection_webhook_retention.connection_id
         AND sibling.event_id = connection_webhook_retention.event_id
         AND sibling.state NOT IN ('resolved', 'ignored'))
     AND NOT EXISTS (SELECT 1 FROM connection_webhook_retention sibling
       JOIN connection_webhook_items i ON i.retention_id = sibling.id
       WHERE sibling.connection_id = connection_webhook_retention.connection_id
         AND sibling.event_id = connection_webhook_retention.event_id
         AND i.state IN ('started', 'uncertain'))`;

/** Selects by the full retention predicate, then deletes under a grant that re-asserts state and age. */
async function deleteRetained(
  ctx: ServiceContext,
  where: string,
  params: number[],
  extra: Record<string, WhereValue>,
): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < 5; pass++) {
    const ids = (
      await all<{ id: string }>(
        ctx.env.DB,
        `SELECT id FROM connection_webhook_retention WHERE ${where} LIMIT ${IDS_PER_PASS}`,
        params,
      )
    ).map((r) => r.id);
    const removed = await deleteIds(ctx, 'connection_webhook_retention', ids, extra);
    total += removed;
    if (ids.length < IDS_PER_PASS || removed === 0) break;
  }
  return total;
}

/** Keep the raw signed body (in the first chunk) while any sibling is unresolved. */
async function deleteFinishedRetainedWebhooks(
  ctx: ServiceContext,
  before: number,
): Promise<number> {
  const db = ctx.env.DB;
  const removed = await deleteRetained(ctx, FINISHED, [before, before], {
    state: inList(['resolved', 'ignored']),
    received_at: lt(before),
    updated_at: lt(before),
  });
  await deleteInBatches(
    db,
    'connection_webhook_legacy_sources',
    `received_at < ? AND NOT EXISTS (SELECT 1 FROM webhook_events e
       WHERE e.connection_id = connection_webhook_legacy_sources.connection_id
         AND e.event_id = connection_webhook_legacy_sources.event_id)
     AND NOT EXISTS (SELECT 1 FROM connection_webhook_retention r
       WHERE r.connection_id = connection_webhook_legacy_sources.connection_id
         AND r.event_id = connection_webhook_legacy_sources.event_id
         AND r.state NOT IN ('resolved', 'ignored'))
     AND NOT EXISTS (SELECT 1 FROM connection_webhook_retention r
       JOIN connection_webhook_items i ON i.retention_id = r.id
       WHERE r.connection_id = connection_webhook_legacy_sources.connection_id
         AND r.event_id = connection_webhook_legacy_sources.event_id
         AND i.state IN ('started', 'uncertain'))`,
    [before],
  );
  return removed;
}

/**
 * `failedBefore` expires failed, blocked and ignored retained payloads that hold no unresolved
 * item: their dedupe row goes first so the daily quarantine cannot re-capture them, then the
 * encrypted rows. An uncertain item keeps its event until an operator resolves it.
 */
export async function deleteOldWebhookEvents(
  ctx: ServiceContext,
  before: number,
  failedBefore?: number,
): Promise<number> {
  const db = ctx.env.DB;
  // Legacy chunks have no event-wide completeness proof; unseen siblings must remain stageable.
  const deleted = await deleteInBatches(
    db,
    'webhook_events',
    `received_at < ? AND EXISTS (
       SELECT 1 FROM connection_webhook_retention r
       WHERE r.connection_id = webhook_events.connection_id AND r.event_id = webhook_events.event_id
     ) AND NOT EXISTS (
       SELECT 1 FROM connection_webhook_retention r
       WHERE r.connection_id = webhook_events.connection_id AND r.event_id = webhook_events.event_id
         AND (r.state NOT IN ('resolved', 'ignored') OR r.updated_at >= ? OR r.source <> 'ingress')
     ) AND NOT EXISTS (
       SELECT 1 FROM connection_webhook_retention r
       JOIN connection_webhook_items i ON i.retention_id = r.id
       WHERE r.connection_id = webhook_events.connection_id AND r.event_id = webhook_events.event_id
         AND i.state IN ('started', 'uncertain')
     ) AND NOT EXISTS (
       SELECT 1 FROM connection_webhook_retention r
       WHERE r.connection_id = webhook_events.connection_id AND r.event_id = webhook_events.event_id
         AND r.source = 'ingress'
       GROUP BY r.connection_id, r.event_id
       HAVING COUNT(*) <> MIN(r.chunk_count) OR COUNT(*) <> MAX(r.chunk_count)
     ) AND NOT EXISTS (
       SELECT 1 FROM connection_inbox i
       WHERE i.connection_id = webhook_events.connection_id AND i.event_id = webhook_events.event_id
     )`,
    [before, before],
  );
  await deleteFinishedRetainedWebhooks(ctx, before);
  if (failedBefore === undefined) return deleted;
  return deleted + (await deleteExpiredUnfinishedWebhooks(ctx, failedBefore));
}

/** Pending chunks are still owed work and never expire; a recent sibling keeps the whole event. */
const EXPIRED_EVENT = `NOT EXISTS (
  SELECT 1 FROM connection_webhook_retention r
  WHERE r.connection_id = #C AND r.event_id = #E
    AND (r.state = 'pending' OR r.updated_at >= ? OR EXISTS (
      SELECT 1 FROM connection_webhook_items i
      WHERE i.retention_id = r.id AND i.state IN ('started', 'uncertain'))))`;

async function deleteExpiredUnfinishedWebhooks(
  ctx: ServiceContext,
  before: number,
): Promise<number> {
  const db = ctx.env.DB;
  const events = await deleteInBatches(
    db,
    'webhook_events',
    `received_at < ? AND EXISTS (
       SELECT 1 FROM connection_webhook_retention r
       WHERE r.connection_id = webhook_events.connection_id AND r.event_id = webhook_events.event_id)
     AND ${EXPIRED_EVENT.replace('#C', 'webhook_events.connection_id').replace('#E', 'webhook_events.event_id')}
     AND NOT EXISTS (SELECT 1 FROM connection_inbox i
       WHERE i.connection_id = webhook_events.connection_id AND i.event_id = webhook_events.event_id)`,
    [before, before],
  );
  const rows = await deleteRetained(
    ctx,
    `state <> 'pending' AND received_at < ? AND updated_at < ?
     AND NOT EXISTS (SELECT 1 FROM webhook_events e
       WHERE e.connection_id = connection_webhook_retention.connection_id
         AND e.event_id = connection_webhook_retention.event_id)
     AND ${EXPIRED_EVENT.replace('#C', 'connection_webhook_retention.connection_id').replace('#E', 'connection_webhook_retention.event_id')}`,
    [before, before, before],
    {
      state: inList(['failed', 'blocked', 'resolved', 'ignored']),
      received_at: lt(before),
      updated_at: lt(before),
    },
  );
  return events + rows;
}

/**
 * A deleted connection's encrypted payloads have no use. Unresolved work cannot be deleted (its
 * claim keeps fencing the pass), so its envelope is wiped and the row closed instead.
 */
export async function purgeConnectionWebhooks(
  ctx: ServiceContext,
  connectionId: string,
  actor: ConnectionActor,
): Promise<void> {
  const db = ctx.env.DB;
  for (let pass = 0; pass < 5; pass++) {
    const rows = await all<{ id: string; unresolved: number }>(
      db,
      `SELECT id, EXISTS (SELECT 1 FROM connection_webhook_items i
         WHERE i.retention_id = connection_webhook_retention.id AND i.state IN ('started', 'uncertain')) AS unresolved
       FROM connection_webhook_retention WHERE connection_id = ? AND org_id = ? LIMIT ${IDS_PER_PASS}`,
      [connectionId, actor.orgId],
    );
    const g = connectionGrant(ctx, actor, 'webhooks.purge', [], connectionId);
    // The connection is gone, so nothing can resolve a claim later: release the passes they fence.
    for (const row of rows.filter((r) => r.unresolved === 1))
      g.joined('connection_webhook_items', {
        set: { state: 'success', token: null, error_code: 'WEBHOOK_CONNECTION_DELETED' },
        where: { retention_id: row.id, state: inList(['started', 'uncertain']) },
      });
    for (const chunk of chunks(rows.map((r) => r.id)))
      g.delete('connection_webhook_retention', {
        where: { id: inList(chunk), connection_id: connectionId },
      });
    plainWrite(
      g,
      'DELETE FROM connection_webhook_legacy_sources WHERE connection_id = ? AND org_id = {org} AND {grant}',
      [connectionId],
    );
    if ((await commitOrNull(g, actor)) === null || rows.length < IDS_PER_PASS) break;
  }
}
