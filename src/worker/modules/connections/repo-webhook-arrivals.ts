import type { ArrivalDto } from '../../../shared/contracts/index.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all, batch, chunk, first, placeholders, run, stmt } from '../../platform/db.ts';

export const ARRIVALS_KEPT = 50;
/** Rejects are what an unauthenticated sender can add: they may never push out the verified rows. */
export const REJECTS_KEPT = 20;
/** Ignores and duplicates can be replayed by anyone holding a captured body, so they share a cap too. */
export const IGNORED_KEPT = 20;
/** A stale ignore is a sample or a replay: it never counts as a verified arrival. */
const VERIFIED = `outcome <> 'rejected' AND COALESCE(reason, '') <> 'stale'`;
const STALE_RUN_MIN = 3;
const STALE_WINDOW_MS = 24 * 3_600_000;

export type ArrivalOutcome = 'accepted' | 'duplicate' | 'ignored' | 'rejected';
export type ContentClass = 'json' | 'xml' | 'form' | 'other';

export interface ArrivalRow {
  id: string;
  receivedAt: number;
  lastAt: number;
  outcome: ArrivalOutcome;
  reason: ArrivalDto['reason'];
  topic: string | null;
  contentClass: ContentClass;
  eventRef: string | null;
  retentionId: string | null;
  usedPrevious: boolean;
  count: number;
}

interface ArrivalSql {
  id: string;
  received_at: number;
  last_at: number;
  outcome: ArrivalOutcome;
  reason: ArrivalDto['reason'];
  topic: string | null;
  content_class: ContentClass;
  event_ref: string | null;
  retention_id: string | null;
  used_previous: number;
  count: number;
}

export interface NewArrival {
  id: string;
  orgId: string;
  connectionId: string;
  now: number;
  outcome: ArrivalOutcome;
  reason: string | null;
  topic: string | null;
  contentClass: ContentClass;
  /** Accepted and duplicate events only. */
  eventId: string | null;
  usedPrevious: boolean;
  /** Null: one row for this arrival. Else the rows with the same key within the minute become one. */
  coalesceKey: string | null;
}

/** The earliest verified row of a connection: it outlives the cap and the purge (first_verified_arrival_at). */
const EARLIEST_VERIFIED = `COALESCE((SELECT f.id FROM connection_webhook_arrivals f
  WHERE f.connection_id = connection_webhook_arrivals.connection_id
    AND f.outcome <> 'rejected' AND COALESCE(f.reason, '') <> 'stale'
  ORDER BY f.received_at, f.id LIMIT 1), '')`;

/** Inserts the row, or counts it into the row with the same key. Prunes only when a row was added. */
export async function writeArrival(db: D1Database, a: NewArrival): Promise<void> {
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO connection_webhook_arrivals
       (id, org_id, connection_id, received_at, last_at, outcome, reason, topic, content_class,
        event_ref, retention_id, used_previous, count, coalesce_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       (SELECT r.id FROM connection_webhook_retention r
         WHERE r.connection_id = ? AND r.event_id = ? ORDER BY r.received_at DESC LIMIT 1),
       ?, 1, ?)
     ON CONFLICT (connection_id, coalesce_key) DO UPDATE SET
       count = count + 1, last_at = excluded.last_at,
       used_previous = MAX(used_previous, excluded.used_previous)
     RETURNING count`,
    [
      a.id,
      a.orgId,
      a.connectionId,
      a.now,
      a.now,
      a.outcome,
      a.reason,
      a.topic,
      a.contentClass,
      a.eventId,
      a.connectionId,
      a.eventId,
      a.usedPrevious ? 1 : 0,
      a.coalesceKey,
    ],
  );
  if (row?.count !== 1) return;
  await batch(db, [
    stmt(
      db,
      `DELETE FROM connection_webhook_arrivals
       WHERE connection_id = ? AND outcome = 'rejected' AND id NOT IN (
         SELECT id FROM connection_webhook_arrivals WHERE connection_id = ? AND outcome = 'rejected'
         ORDER BY last_at DESC, id DESC LIMIT ${REJECTS_KEPT})`,
      [a.connectionId, a.connectionId],
    ),
    stmt(
      db,
      `DELETE FROM connection_webhook_arrivals
       WHERE connection_id = ? AND outcome IN ('ignored', 'duplicate') AND id <> ${EARLIEST_VERIFIED} AND id NOT IN (
         SELECT id FROM connection_webhook_arrivals WHERE connection_id = ? AND outcome IN ('ignored', 'duplicate')
         ORDER BY last_at DESC, id DESC LIMIT ${IGNORED_KEPT})`,
      [a.connectionId, a.connectionId],
    ),
    stmt(
      db,
      `DELETE FROM connection_webhook_arrivals
       WHERE connection_id = ? AND id <> ${EARLIEST_VERIFIED} AND id NOT IN (
         SELECT id FROM connection_webhook_arrivals WHERE connection_id = ?
         ORDER BY last_at DESC, id DESC LIMIT ${ARRIVALS_KEPT})`,
      [a.connectionId, a.connectionId],
    ),
  ]);
}

/** Newest first. `since` keeps rows seen or counted again after it, so a coalesced row ticks. */
export async function listArrivals(
  db: D1Database,
  orgId: string,
  connectionId: string,
  since: number,
  limit: number,
): Promise<ArrivalRow[]> {
  const rows = await all<ArrivalSql>(
    db,
    `SELECT id, received_at, last_at, outcome, reason, topic, content_class, event_ref, retention_id, used_previous, count
     FROM connection_webhook_arrivals WHERE org_id = ? AND connection_id = ? AND last_at > ?
     ORDER BY last_at DESC, id DESC LIMIT ?`,
    [orgId, connectionId, since, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.received_at,
    lastAt: r.last_at,
    outcome: r.outcome,
    reason: r.reason,
    topic: r.topic,
    contentClass: r.content_class,
    eventRef: r.event_ref,
    retentionId: r.retention_id,
    usedPrevious: r.used_previous === 1,
    count: r.count,
  }));
}

/** The kept-event id of an accepted arrival of this connection; null when it has none or is not there. */
export async function retentionIdOfArrival(
  db: D1Database,
  orgId: string,
  connectionId: string,
  arrivalId: string,
): Promise<{ found: boolean; retentionId: string | null }> {
  const r = await first<{ retention_id: string | null }>(
    db,
    `SELECT retention_id FROM connection_webhook_arrivals
     WHERE org_id = ? AND connection_id = ? AND id = ? AND outcome = 'accepted'`,
    [orgId, connectionId, arrivalId],
  );
  return { found: r !== null, retentionId: r?.retention_id ?? null };
}

export interface ArrivalSummary {
  /** When the first correctly signed, non-stale delivery arrived. */
  firstVerifiedAt: number | null;
  /** Three or more stale deliveries in a day, and no good one since. */
  staleRun: boolean;
}

/** Verified-arrival time and stale-run state for a page of connections: one query per 90. */
export async function arrivalSummaries(
  db: D1Database,
  connectionIds: readonly string[],
  now: number,
): Promise<Map<string, ArrivalSummary>> {
  const out = new Map<string, ArrivalSummary>();
  for (const ids of chunk(connectionIds)) {
    const rows = await all<{
      connection_id: string;
      first_at: number | null;
      last_ok: number | null;
      last_stale: number | null;
      stale_n: number | null;
    }>(
      db,
      `SELECT connection_id,
         MIN(CASE WHEN ${VERIFIED} THEN received_at END) AS first_at,
         MAX(CASE WHEN ${VERIFIED} THEN last_at END) AS last_ok,
         MAX(CASE WHEN reason = 'stale' THEN last_at END) AS last_stale,
         SUM(CASE WHEN reason = 'stale' AND last_at > ? THEN count ELSE 0 END) AS stale_n
       FROM connection_webhook_arrivals WHERE connection_id IN (${placeholders(ids.length)})
       GROUP BY connection_id`,
      [now - STALE_WINDOW_MS, ...ids],
    );
    for (const r of rows) {
      out.set(r.connection_id, {
        firstVerifiedAt: r.first_at,
        staleRun: (r.stale_n ?? 0) >= STALE_RUN_MIN && (r.last_stale ?? 0) > (r.last_ok ?? 0),
      });
    }
  }
  return out;
}

/** Rows last seen before `before`, except each connection's earliest verified one. */
export function deleteOldArrivals(db: D1Database, before: number): Promise<number> {
  return deleteInBatches(
    db,
    'connection_webhook_arrivals',
    `last_at < ? AND id <> ${EARLIEST_VERIFIED}`,
    [before],
  );
}

/** After the retention window the exempt row keeps its time but not the provider's event id or the link. */
export async function clearOldArrivalRefs(db: D1Database, before: number): Promise<number> {
  const { changes } = await run(
    db,
    `UPDATE connection_webhook_arrivals SET event_ref = NULL, retention_id = NULL, topic = NULL
     WHERE last_at < ? AND (event_ref IS NOT NULL OR retention_id IS NOT NULL OR topic IS NOT NULL)`,
    [before],
  );
  return changes;
}
