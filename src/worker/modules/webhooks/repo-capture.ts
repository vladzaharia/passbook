import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import type { WebhookEventType } from '../../../shared/contracts/webhooks.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import { assertOrgModeGrant } from './repo-endpoints.ts';
import type { FeedFence } from './repo-feed.ts';

interface Raw {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: WebhookEventType;
  trigger: WebhookCaptureDto['trigger'];
  headers: string;
  body: string;
  status: number;
  duration_ms: number;
  created_at: number;
}

const COLUMNS = `id, endpoint_id, event_id, event_type, trigger, headers, body, status, duration_ms, created_at`;

function dtoOf(r: Raw): WebhookCaptureDto {
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    eventId: r.event_id,
    type: r.event_type,
    trigger: r.trigger,
    status: r.status,
    durationMs: r.duration_ms,
    headers: JSON.parse(r.headers) as Record<string, string>,
    body: r.body,
    createdAt: r.created_at,
  };
}

/** Newest first. The cursor is `<createdAt>.<id>` of the last row read. */
export async function listCaptures(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  q: {
    limit: number;
    cursor?: string | undefined;
    type?: string | undefined;
    requestId?: string | undefined;
    passId?: string | undefined;
  },
): Promise<{ items: WebhookCaptureDto[]; nextCursor: string | null }> {
  const params: SqlValue[] = [endpointId, fence.orgId, fence.mode];
  let where = '';
  if (q.type) {
    where += ' AND event_type = ?';
    params.push(q.type);
  }
  if (q.requestId || q.passId) {
    where += ` AND event_id IN (SELECT event_id FROM event_feed WHERE org_id = ? AND mode = ?${
      q.passId ? ' AND pass_id = ?' : ''
    }${q.requestId ? " AND json_extract(data, '$.requestId') = ?" : ''})`;
    params.push(fence.orgId, fence.mode);
    if (q.passId) params.push(q.passId);
    if (q.requestId) params.push(q.requestId);
  }
  const m = q.cursor ? /^(\d+)\.(.+)$/.exec(q.cursor) : null;
  if (m) {
    where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(Number(m[1]), Number(m[1]), m[2] ?? '');
  }
  params.push(q.limit + 1);
  const rows = await all<Raw>(
    db,
    `SELECT ${COLUMNS} FROM webhook_captures WHERE endpoint_id = ? AND org_id = ? AND mode = ?${where}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    params,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(dtoOf),
    nextCursor: rows.length > q.limit && last ? `${last.created_at}.${last.id}` : null,
  };
}

export async function getCapture(
  db: D1Database,
  fence: FeedFence,
  endpointId: string,
  id: string,
): Promise<WebhookCaptureDto | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM webhook_captures WHERE id = ? AND endpoint_id = ? AND org_id = ? AND mode = ?`,
    [id, endpointId, fence.orgId, fence.mode],
  );
  return row ? dtoOf(row) : null;
}

/** Captures counted for the org in the clock hour of `now`. */
export async function capturesThisHour(
  db: D1Database,
  orgId: string,
  now: number,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT n FROM webhook_capture_hours WHERE org_id = ? AND hour = ?',
    [orgId, Math.floor(now / 3_600_000)],
  );
  return row?.n ?? 0;
}

/** The org's capture endpoint in Test, oldest first: the one a sandbox is given. */
export async function captureEndpointId(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM webhook_endpoints WHERE org_id = ? AND mode = 'test' AND target = 'capture'
     ORDER BY created_at, id LIMIT 1`,
    [orgId],
  );
  return row?.id ?? null;
}

/** Only a developer org may hold a capture endpoint. */
export async function isDeveloperOrg(db: D1Database, orgId: string): Promise<boolean> {
  const row = await first<{ kind: string }>(db, 'SELECT kind FROM orgs WHERE id = ?', [orgId]);
  return row?.kind === 'developer';
}

/** A request-path capture (test send, replay): the grant supplies the org and mode, and the endpoint must be the tenant's. */
export function insertCapture(
  g: Grant,
  endpointId: string,
  c: {
    id: string;
    eventId: string;
    eventType: string;
    trigger: 'test' | 'replay';
    headers: Record<string, string>;
    body: string;
    durationMs: number;
    at: number;
  },
): GrantedStatement {
  assertOrgModeGrant(g);
  return g.insertSelect(
    'webhook_captures',
    ['id', 'event_id', 'event_type', 'trigger', 'headers', 'body', 'duration_ms', 'created_at'],
    [
      c.id,
      c.eventId,
      c.eventType,
      c.trigger,
      JSON.stringify(c.headers),
      c.body,
      c.durationMs,
      c.at,
    ],
    {
      from: { table: 'webhook_endpoints', where: { id: endpointId }, copy: { endpoint_id: 'id' } },
    },
  );
}
