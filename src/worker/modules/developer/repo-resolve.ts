import { first } from '../../platform/db.ts';
import { LOG_META_MS } from './repo-request-log.ts';

/** The sandbox's own request, by the id the response carried in `x-request-id` (a ray's region letters may be any case). Newest first if the id repeats. */
export const requestByRequestId = (db: D1Database, orgId: string, requestId: string, now: number) =>
  first<{ id: string; request_id: string; method: string; path: string; status: number }>(
    db,
    `SELECT id, request_id, method, path, status FROM request_log
     WHERE org_id = ? AND request_id = ? COLLATE NOCASE AND at >= ? ORDER BY id DESC LIMIT 1`,
    [orgId, requestId, now - LOG_META_MS],
  );

export const passInOrg = (db: D1Database, orgId: string, id: string) =>
  first<{ id: string; serial: string }>(
    db,
    'SELECT id, serial FROM passes WHERE org_id = ? AND id = ?',
    [orgId, id],
  );

export const templateInOrg = (db: D1Database, orgId: string, id: string) =>
  first<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM templates WHERE org_id = ? AND id = ?',
    [orgId, id],
  );
