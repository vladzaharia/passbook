import { rawCheck } from '../../platform/authority-checks.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { chunked, commitOrNull, connectionGrant, retentionIs, rowCount } from './repo-grants.ts';

export async function hasStagedEvent(
  db: D1Database,
  connectionId: string,
  eventId: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM connection_webhook_retention
    WHERE connection_id = ? AND event_id = ? AND source = 'ingress' LIMIT 1`,
      [connectionId, eventId],
    )) !== null
  );
}

/** Staged but never dispatched, or dispatch failed on enqueue: the provider's retry must re-dispatch. */
export async function hasUncertainDispatch(
  db: D1Database,
  connectionId: string,
  eventId: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM connection_webhook_retention
    WHERE connection_id = ? AND event_id = ? AND source = 'ingress'
    GROUP BY connection_id, event_id
    HAVING COUNT(*) <> MIN(chunk_count) OR COUNT(*) <> MAX(chunk_count)
      OR SUM(CASE WHEN state = 'pending' AND dispatch_complete = 0 THEN 1 ELSE 0 END) > 0
      OR SUM(CASE WHEN state = 'failed' AND error_code = 'WEBHOOK_ENQUEUE_FAILED' THEN 1 ELSE 0 END) > 0`,
      [connectionId, eventId],
    )) !== null
  );
}

/** Every ingress chunk of one event shares this chunk count and keyset (read, then asserted in the grant). */
const EVENT_CONSISTENT = `(SELECT COUNT(*) FROM connection_webhook_retention r
    WHERE r.connection_id = ? AND r.event_id = ? AND r.source = 'ingress') = ?
  AND NOT EXISTS (SELECT 1 FROM connection_webhook_retention r
    WHERE r.connection_id = ? AND r.event_id = ? AND r.source = 'ingress'
      AND (r.chunk_count <> ? OR r.credential_keyset_commitment IS NOT ?))`;

export async function completeDispatch(
  ctx: ServiceContext,
  orgId: string,
  connectionId: string,
  eventId: string,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(credentialKeysetCommitment)) return false;
  const chunks = await all<{ id: string; chunk_count: number; error_code: string | null }>(
    ctx.env.DB,
    `SELECT id, chunk_count, error_code FROM connection_webhook_retention
     WHERE connection_id = ? AND org_id = ? AND event_id = ? AND source = 'ingress'
       AND credential_keyset_commitment = ?`,
    [connectionId, orgId, eventId, credentialKeysetCommitment],
  );
  const count = chunks[0]?.chunk_count;
  if (count === undefined || chunks.length !== count) return false;
  const actor = { orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.dispatch_complete',
    [
      rawCheck('retention', EVENT_CONSISTENT, [
        connectionId,
        eventId,
        count,
        connectionId,
        eventId,
        count,
        credentialKeysetCommitment,
      ]),
    ],
    eventId,
  );
  const where = {
    connection_id: connectionId,
    event_id: eventId,
    source: 'ingress',
    credential_keyset_commitment: credentialKeysetCommitment,
  };
  const pending = chunks.filter((c) => c.error_code === 'WEBHOOK_DISPATCH_PENDING');
  const other = chunks.filter((c) => c.error_code !== 'WEBHOOK_DISPATCH_PENDING');
  for (const ids of chunked(pending.map((c) => c.id)))
    g.update('connection_webhook_retention', {
      set: { dispatch_complete: 1, error_code: null },
      where: { ...where, id: inList(ids) },
    });
  for (const ids of chunked(other.map((c) => c.id)))
    g.update('connection_webhook_retention', {
      set: { dispatch_complete: 1 },
      where: { ...where, id: inList(ids) },
    });
  return (await commitOrNull(g, actor)) !== null;
}

/** Return chunks whose enqueue failed to pending so they dispatch again; their items never ran. */
export async function reopenEnqueueFailed(
  ctx: ServiceContext,
  orgId: string,
  connectionId: string,
  eventId: string,
  now: number,
  credentialKeysetCommitment: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(credentialKeysetCommitment)) return;
  const ids = await all<{ id: string }>(
    ctx.env.DB,
    `SELECT id FROM connection_webhook_retention
     WHERE connection_id = ? AND org_id = ? AND event_id = ? AND source = 'ingress'
       AND state = 'failed' AND error_code = 'WEBHOOK_ENQUEUE_FAILED' AND credential_keyset_commitment = ?
       AND NOT EXISTS (SELECT 1 FROM connection_webhook_items i
         WHERE i.retention_id = connection_webhook_retention.id AND i.state <> 'pending')`,
    [connectionId, orgId, eventId, credentialKeysetCommitment],
  );
  if (ids.length === 0) return;
  const actor = { orgId };
  const g = connectionGrant(ctx, actor, 'webhook.reopen', [], eventId);
  for (const chunk of chunked(ids.map((r) => r.id)))
    g.update('connection_webhook_retention', {
      set: {
        state: 'pending',
        error_code: 'WEBHOOK_DISPATCH_PENDING',
        dispatch_complete: 0,
        updated_at: now,
      },
      inc: ['revision'],
      where: {
        id: inList(chunk),
        state: 'failed',
        error_code: 'WEBHOOK_ENQUEUE_FAILED',
        credential_keyset_commitment: credentialKeysetCommitment,
      },
    });
  await commitOrNull(g, actor);
}

export interface UndispatchedEvent {
  orgId: string;
  connectionId: string;
  eventId: string;
  credentialKeysetCommitment: string;
}

/** Events of a still-current connection whose chunks sat undispatched past `before`. */
export async function undispatchedEvents(
  db: D1Database,
  before: number,
  limit: number,
): Promise<UndispatchedEvent[]> {
  const rows = await all<{
    org_id: string;
    connection_id: string;
    event_id: string;
    proof: string;
  }>(
    db,
    `SELECT r.org_id, r.connection_id, r.event_id, MIN(r.credential_keyset_commitment) AS proof
    FROM connection_webhook_retention r
    JOIN orgs ao ON ao.id = r.org_id AND ao.status = 'active'
    JOIN connections c ON c.id = r.connection_id AND c.org_id = r.org_id
      AND c.generation = r.generation AND c.enabled = 1 AND c.mode IN ('webhook', 'hybrid')
    WHERE r.source = 'ingress' AND r.updated_at < ? AND r.credential_keyset_commitment IS NOT NULL
      AND ((r.state = 'pending' AND r.dispatch_complete = 0)
        OR (r.state = 'failed' AND r.error_code = 'WEBHOOK_ENQUEUE_FAILED'))
    GROUP BY r.connection_id, r.event_id ORDER BY MIN(r.updated_at) LIMIT ?`,
    [before, limit],
  );
  return rows.map((r) => ({
    orgId: r.org_id,
    connectionId: r.connection_id,
    eventId: r.event_id,
    credentialKeysetCommitment: r.proof,
  }));
}

export interface StalledReplay {
  id: string;
  orgId: string;
  revision: number;
}

/** Replayed chunks still `pending` long after their reservation: the enqueue or its restore was lost. */
export async function stalledReplays(
  db: D1Database,
  before: number,
  limit: number,
): Promise<StalledReplay[]> {
  const rows = await all<{ id: string; org_id: string; revision: number }>(
    db,
    `SELECT r.id, r.org_id, r.revision FROM connection_webhook_retention r
     JOIN orgs o ON o.id = r.org_id AND o.status = 'active'
     WHERE r.state = 'pending' AND r.dispatch_complete = 1 AND r.last_replay_id IS NOT NULL
       AND r.updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = r.id AND i.state = 'started')
     ORDER BY r.updated_at LIMIT ?`,
    [before, limit],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, revision: r.revision }));
}

/**
 * Parks a stalled replay: the chunk fails and its never-claimed items become failed (not uncertain), so
 * the operator's Replay still re-runs them.
 */
export async function parkStalledReplay(
  ctx: ServiceContext,
  row: StalledReplay,
  now: number,
): Promise<boolean> {
  const pending = await all<{ ordinal: number }>(
    ctx.env.DB,
    "SELECT ordinal FROM connection_webhook_items WHERE retention_id = ? AND state = 'pending'",
    [row.id],
  );
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.replay_stalled',
    [
      retentionIs(row.id, { state: 'pending', revision: row.revision }),
      rawCheck(
        'retention',
        "NOT EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = ? AND i.state = 'started')",
        [row.id],
      ),
    ],
    row.id,
  );
  for (const item of pending)
    g.joined('connection_webhook_items', {
      set: { state: 'failed', token: null, error_code: 'WEBHOOK_REPLAY_STALLED' },
      where: { retention_id: row.id, ordinal: item.ordinal, state: 'pending' },
    });
  g.update('connection_webhook_retention', {
    set: { state: 'failed', error_code: 'WEBHOOK_REPLAY_STALLED', updated_at: now },
    inc: ['revision'],
    where: { id: row.id, state: 'pending', revision: row.revision },
    returning: ['id'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}
