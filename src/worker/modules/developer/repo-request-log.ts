import { all, first, run, type SqlValue } from '../../platform/db.ts';

const DAY = 86_400_000;
/** Metadata (method, route, status, code, time) is kept this long. */
export const LOG_META_MS = 7 * DAY;
/** Bodies are kept this long, in developer Test traffic only. */
export const LOG_BODY_MS = DAY;

export interface LogRow {
  id: string;
  org_id: string;
  key_id: string | null;
  via: 'try' | null;
  mode: 'live' | 'test';
  request_id: string;
  method: string;
  route: string | null;
  path: string;
  query: string | null;
  status: number;
  code: string | null;
  duration_ms: number;
  at: number;
  has_bodies: number;
  request_body: string | null;
  response_body: string | null;
}

export interface NewLog {
  id: string;
  orgId: string;
  keyId: string;
  via: 'try' | null;
  mode: 'live' | 'test';
  requestId: string;
  method: string;
  route: string | null;
  path: string;
  /** The query with values redacted: kept for a developer Test call. */
  query: string | null;
  /** The query's parameter names alone: what every other call keeps. */
  queryKeys: string | null;
  status: number;
  code: string | null;
  durationMs: number;
  at: number;
  requestBody: string | null;
  responseBody: string | null;
}

/**
 * The one write of a request. Bodies and query values are kept only when the org is a developer org and the call
 * was Test: the SELECT decides that from the org row, so a body for any other call is never bound to a column, and
 * the table's triggers refuse one anyway.
 */
export const insertLog = (db: D1Database, l: NewLog) =>
  run(
    db,
    `INSERT INTO request_log (id, org_id, key_id, via, mode, request_id, method, route, path, query, status, code,
       duration_ms, at, has_bodies, request_body, response_body)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       CASE WHEN ?5 = 'test' AND o.kind = 'developer' THEN ?10 ELSE ?17 END, ?11, ?12, ?13, ?14,
       CASE WHEN ?5 = 'test' AND o.kind = 'developer' AND (?15 IS NOT NULL OR ?16 IS NOT NULL) THEN 1 ELSE 0 END,
       CASE WHEN ?5 = 'test' AND o.kind = 'developer' THEN ?15 END,
       CASE WHEN ?5 = 'test' AND o.kind = 'developer' THEN ?16 END
     FROM orgs o WHERE o.id = ?2`,
    [
      l.id,
      l.orgId,
      l.keyId,
      l.via,
      l.mode,
      l.requestId,
      l.method,
      l.route,
      l.path,
      l.query,
      l.status,
      l.code,
      l.durationMs,
      l.at,
      l.requestBody,
      l.responseBody,
      l.queryKeys,
    ],
  );

export interface LogFilter {
  keyId?: string;
  status?: string;
  code?: string;
  path?: string;
  method?: string;
}

function where(orgId: string, f: LogFilter, now: number, cursor?: string) {
  const sql = ['org_id = ?', 'at >= ?'];
  const params: SqlValue[] = [orgId, now - LOG_META_MS];
  const add = (clause: string, ...values: SqlValue[]) => {
    sql.push(clause);
    params.push(...values);
  };
  if (f.keyId) add('key_id = ?', f.keyId);
  if (f.code) add('code = ?', f.code);
  if (f.method) add('method = ?', f.method);
  if (f.path) add('instr(path, ?) > 0', f.path);
  if (f.status?.endsWith('xx')) {
    const hundred = Number(f.status[0]) * 100;
    add('status >= ? AND status < ?', hundred, hundred + 100);
  } else if (f.status) add('status = ?', Number(f.status));
  if (cursor) add('id < ?', cursor);
  return { sql: sql.join(' AND '), params };
}

/** A body is readable for 24 hours; the column may outlive that until the purge, the read never shows it. */
const readable = (now: number) => `(has_bodies = 1 AND at >= ${now - LOG_BODY_MS})`;

const LIST_COLUMNS = (now: number) =>
  `id, org_id, key_id, via, mode, request_id, method, route, path, query, status, code, duration_ms, at,
   CASE WHEN ${readable(now)} THEN 1 ELSE 0 END AS has_bodies`;

export const listLogs = (
  db: D1Database,
  orgId: string,
  filter: LogFilter,
  limit: number,
  now: number,
  cursor?: string,
) => {
  const w = where(orgId, filter, now, cursor);
  return all<Omit<LogRow, 'request_body' | 'response_body'>>(
    db,
    `SELECT ${LIST_COLUMNS(now)} FROM request_log WHERE ${w.sql} ORDER BY id DESC LIMIT ?`,
    [...w.params, limit],
  );
};

export const getLog = (db: D1Database, orgId: string, id: string, now: number) =>
  first<LogRow>(
    db,
    `SELECT id, org_id, key_id, via, mode, request_id, method, route, path, query, status, code, duration_ms, at,
       CASE WHEN ${readable(now)} THEN 1 ELSE 0 END AS has_bodies,
       CASE WHEN ${readable(now)} THEN request_body END AS request_body,
       CASE WHEN ${readable(now)} THEN response_body END AS response_body
     FROM request_log WHERE org_id = ? AND id = ? AND at >= ?`,
    [orgId, id, now - LOG_META_MS],
  );

export const callsSince = async (db: D1Database, orgId: string, since: number) =>
  (
    await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM request_log WHERE org_id = ? AND at >= ?',
      [orgId, since],
    )
  )?.n ?? 0;

/** Blanks the bodies of rows older than `cutoff`: the row and its metadata stay. */
export const purgeBodies = async (db: D1Database, cutoff: number, limit: number) =>
  (
    await run(
      db,
      `UPDATE request_log SET request_body = NULL, response_body = NULL, has_bodies = 0
       WHERE rowid IN (SELECT rowid FROM request_log WHERE has_bodies = 1 AND at < ? LIMIT ?)`,
      [cutoff, limit],
    )
  ).changes;

export const purgeRows = async (db: D1Database, cutoff: number, limit: number) =>
  (
    await run(
      db,
      'DELETE FROM request_log WHERE rowid IN (SELECT rowid FROM request_log WHERE at < ? LIMIT ?)',
      [cutoff, limit],
    )
  ).changes;
