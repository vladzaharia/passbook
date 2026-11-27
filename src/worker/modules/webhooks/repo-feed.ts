import type { Mode } from '../../../shared/contracts/common.ts';
import { first, placeholders, stmt } from '../../platform/db.ts';
import type { FeedRow } from './payload.ts';

/** The org and mode of the caller's authority: every feed read is fenced by both. */
export interface FeedFence {
  orgId: string;
  mode: Mode;
}

interface Raw {
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

const COLUMNS = `f.seq, f.event_id, f.org_id, f.mode, f.pass_id, f.template_id, f.external_id, f.type,
  f.kind, f.device, f.device_count, f.actor_type, f.data, f.at`;

export function feedRowOf(r: Raw): FeedRow {
  return {
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
  };
}

export interface FeedQuery {
  /** Rows with a higher seq only. */
  after: number;
  types?: readonly string[] | undefined;
  passId?: string | undefined;
  requestId?: string | undefined;
  limit: number;
  /** Newest first, for a first read of the latest rows. */
  desc?: boolean | undefined;
}

/** Quarantined (sandbox-captured) passes never show in the feed. */
const FENCED = `JOIN passes p ON p.id = f.pass_id AND p.org_id = f.org_id AND p.mode = f.mode
  AND p.test_data_quarantined = 0`;

/** Ascending by seq (descending with `desc`), so a poller tails it. Asks for one extra row so the caller can set `hasMore`. */
export function feedStmt(db: D1Database, fence: FeedFence, q: FeedQuery): D1PreparedStatement {
  const types = q.types ?? [];
  return stmt(
    db,
    `SELECT ${COLUMNS} FROM event_feed f ${FENCED}
     WHERE f.org_id = ? AND f.mode = ? AND f.seq > ?
       ${types.length > 0 ? `AND f.type IN (${placeholders(types.length)})` : ''}
       ${q.passId ? 'AND f.pass_id = ?' : ''}
       ${q.requestId ? "AND json_extract(f.data, '$.requestId') = ?" : ''}
     ORDER BY f.seq ${q.desc ? 'DESC' : ''} LIMIT ?`,
    [
      fence.orgId,
      fence.mode,
      q.after,
      ...types,
      ...(q.passId ? [q.passId] : []),
      ...(q.requestId ? [q.requestId] : []),
      q.limit + 1,
    ],
  );
}

export async function listFeed(
  db: D1Database,
  fence: FeedFence,
  q: FeedQuery,
): Promise<{ rows: FeedRow[]; hasMore: boolean }> {
  const result = await feedStmt(db, fence, q).all<Raw>();
  const rows = result.results.map(feedRowOf);
  return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

/** The newest seq of the org and mode, or 0: where `after=now` starts. */
export async function feedHead(db: D1Database, fence: FeedFence): Promise<number> {
  const row = await first<{ seq: number | null }>(
    db,
    'SELECT max(f.seq) AS seq FROM event_feed f WHERE f.org_id = ? AND f.mode = ?',
    [fence.orgId, fence.mode],
  );
  return row?.seq ?? 0;
}

export async function getFeedEvent(
  db: D1Database,
  fence: FeedFence,
  eventId: string,
): Promise<FeedRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM event_feed f ${FENCED}
     WHERE f.event_id = ? AND f.org_id = ? AND f.mode = ?`,
    [eventId, fence.orgId, fence.mode],
  );
  return row ? feedRowOf(row) : null;
}
