import { first } from '../../platform/db.ts';
import { LOG_META_MS } from './repo-request-log.ts';

/** The sandbox's own request, by the id the response carried in `x-request-id` (a ray's region letters may be any case). Newest first if the id repeats. */
export const requestByRequestId = (db: D1Database, orgId: string, requestId: string, now: number) =>
  first<{ id: string; request_id: string; method: string; path: string; status: number }>(
    db,
    `SELECT id, request_id, method, path, status FROM request_log
     WHERE org_id = ? AND mode = 'test' AND request_id = ? COLLATE NOCASE AND at >= ? ORDER BY id DESC LIMIT 1`,
    [orgId, requestId, now - LOG_META_MS],
  );

export const passInOrg = (db: D1Database, orgId: string, id: string) =>
  first<{ id: string; serial: string }>(
    db,
    "SELECT id, serial FROM passes WHERE org_id = ? AND mode = 'test' AND id = ?",
    [orgId, id],
  );

export const templateInOrg = (db: D1Database, orgId: string, id: string) =>
  first<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM templates WHERE org_id = ? AND id = ?',
    [orgId, id],
  );

const one = <T>(db: D1Database, sql: string, orgId: string, id: string) =>
  first<T>(db, sql, [orgId, id]);

export const keyInOrg = (db: D1Database, orgId: string, id: string) =>
  one<{ id: string; name: string }>(
    db,
    "SELECT id, name FROM api_keys WHERE org_id = ? AND mode = 'test' AND id = ?",
    orgId,
    id,
  );

export const eventInOrg = (db: D1Database, orgId: string, id: string) =>
  one<{ event_id: string; type: string }>(
    db,
    "SELECT event_id, type FROM event_feed WHERE org_id = ? AND mode = 'test' AND event_id = ?",
    orgId,
    id,
  );

export const endpointInOrg = (db: D1Database, orgId: string, id: string) =>
  one<{ id: string; target: 'url' | 'capture' }>(
    db,
    "SELECT id, target FROM webhook_endpoints WHERE org_id = ? AND mode = 'test' AND id = ?",
    orgId,
    id,
  );

export const captureInOrg = (db: D1Database, orgId: string, id: string) =>
  one<{ id: string; event_id: string; event_type: string }>(
    db,
    "SELECT id, event_id, event_type FROM webhook_captures WHERE org_id = ? AND mode = 'test' AND id = ?",
    orgId,
    id,
  );

/** A delivery attempt: the only delivery row with an id of its own. `event_id` is null for a test send. */
export const attemptInOrg = (db: D1Database, orgId: string, id: string) =>
  one<{ id: string; endpoint_id: string; event_id: string | null; attempt: number }>(
    db,
    `SELECT a.id, a.endpoint_id, f.event_id, a.attempt FROM webhook_attempts a
     LEFT JOIN event_feed f ON f.seq = a.event_seq AND f.org_id = a.org_id AND f.mode = a.mode
     WHERE a.org_id = ? AND a.mode = 'test' AND a.id = ?`,
    orgId,
    id,
  );

export const operationInOrg = (db: D1Database, orgId: string, id: string) =>
  one<{ id: string; kind: string }>(
    db,
    "SELECT id, kind FROM operations WHERE org_id = ? AND mode = 'test' AND id = ?",
    orgId,
    id,
  );

/** What the id names in the org's Live mode, which the Workbench never opens. `pass_id` is where admin shows it. */
export interface LiveRow {
  what: 'pass' | 'key' | 'endpoint' | 'event';
  pass_id: string | null;
}
export const liveInOrg = (db: D1Database, orgId: string, id: string) =>
  first<LiveRow>(
    db,
    `SELECT 'pass' AS what, id AS pass_id FROM passes WHERE org_id = ?1 AND mode = 'live' AND id = ?2
     UNION ALL SELECT 'key', NULL FROM api_keys WHERE org_id = ?1 AND mode = 'live' AND id = ?2
     UNION ALL SELECT 'endpoint', NULL FROM webhook_endpoints WHERE org_id = ?1 AND mode = 'live' AND id = ?2
     UNION ALL SELECT 'event', pass_id FROM event_feed WHERE org_id = ?1 AND mode = 'live' AND event_id = ?2
     LIMIT 1`,
    [orgId, id],
  );
