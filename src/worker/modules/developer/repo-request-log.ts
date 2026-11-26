import { all, first, run, type SqlValue } from '../../platform/db.ts';

const DAY = 86_400_000;
/** Metadata (method, route, status, code, time) is kept this long. */
export const LOG_META_MS = 7 * DAY;
/** Bodies are kept this long, in Test traffic of orgs that record them. */
export const LOG_BODY_MS = DAY;

export interface LogRow {
  id: string;
  org_id: string;
  key_id: string | null;
  via: 'try' | null;
  client: string | null;
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
  resource_id: string | null;
  api_version: string | null;
  flags: number;
  bodies_truncated: number;
  has_bodies: number;
  request_body: string | null;
  response_body: string | null;
}

export interface NewLog {
  id: string;
  orgId: string;
  keyId: string;
  via: 'try' | null;
  /** `clientOf` of the User-Agent: a short name, never the header. */
  client?: string | null;
  mode: 'live' | 'test';
  requestId: string;
  method: string;
  route: string | null;
  path: string;
  /** The query with values redacted. */
  query: string | null;
  status: number;
  code: string | null;
  durationMs: number;
  at: number;
  /** The pass, template or key the route touched. */
  resourceId?: string | null;
  /** The `PassBook-Version` date the call pinned. */
  apiVersion?: string | null;
  /** `FLAG_*` bits: which of the three headers the call carried. */
  flags?: number;
  /** A stored body was cut at 8 KB. */
  bodiesTruncated?: boolean;
  requestBody: string | null;
  responseBody: string | null;
}

export const FLAG_IDEMPOTENCY_KEY = 1;
export const FLAG_IF_MATCH = 2;
export const FLAG_VERSION = 4;

export const HOUR_ROWS_CAP = 2000;
export const TOTAL_ROWS_CAP = 20_000;

/**
 * The one write of a request, for a Test call: the SELECT reads the org's row budget, so an org over its hourly or
 * total cap writes nothing, and a body is bound only when the call was Test (the caller binds none when the org
 * does not record bodies). The table's triggers refuse a Live row, a body and a query value outside Test.
 * Returns whether a row was written.
 */
export const insertLog = async (db: D1Database, l: NewLog) =>
  l.mode === 'test' &&
  (
    await run(
      db,
      `INSERT INTO request_log (id, org_id, key_id, via, mode, request_id, method, route, path, query, status, code,
         duration_ms, at, has_bodies, request_body, response_body, client, resource_id, api_version, flags, bodies_truncated)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
         CASE WHEN ?5 = 'test' AND (?15 IS NOT NULL OR ?16 IS NOT NULL) THEN 1 ELSE 0 END,
         CASE WHEN ?5 = 'test' THEN ?15 END,
         CASE WHEN ?5 = 'test' THEN ?16 END, ?17
         , ?18, ?19, ?20, ?21
       FROM orgs o WHERE o.id = ?2
         AND COALESCE((SELECT CASE WHEN b.hour = CAST(?14 AS INTEGER) / 3600000 THEN b.hour_rows ELSE 0 END
                       FROM request_log_budget b WHERE b.org_id = ?2), 0) < ${HOUR_ROWS_CAP}
         AND COALESCE((SELECT b.total_rows FROM request_log_budget b WHERE b.org_id = ?2), 0) < ${TOTAL_ROWS_CAP}`,
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
        l.client ?? null,
        l.resourceId ?? null,
        l.apiVersion ?? null,
        l.flags ?? 0,
        l.bodiesTruncated ? 1 : 0,
      ],
    )
  ).changes > 0;

/** The org's kind (`developer` for a sandbox), null when there is no such org. */
export const orgKindOf = async (db: D1Database, orgId: string) =>
  (await first<{ kind: string }>(db, 'SELECT kind FROM orgs WHERE id = ?', [orgId]))?.kind ?? null;

/** `hour`: this hour's cap is spent; `total`: the org holds its most rows. Null: room left. */
export async function logCap(
  db: D1Database,
  orgId: string,
  now: number,
): Promise<'hour' | 'total' | null> {
  const b = await first<{ hour: number; hour_rows: number; total_rows: number }>(
    db,
    'SELECT hour, hour_rows, total_rows FROM request_log_budget WHERE org_id = ?',
    [orgId],
  );
  if (!b) return null;
  if (b.total_rows >= TOTAL_ROWS_CAP) return 'total';
  return b.hour === Math.floor(now / 3_600_000) && b.hour_rows >= HOUR_ROWS_CAP ? 'hour' : null;
}

export interface LogFilter {
  keyId?: string;
  status?: string;
  code?: string;
  path?: string;
  method?: string;
  /** `key`: a key's own calls (`via` null); `try`: Run here. */
  source?: 'key' | 'try' | 'all';
  /** `hide`: leave out the portal's own background reads. */
  portal?: 'show' | 'hide';
  /** The pass, template or key a call touched. */
  passId?: string;
  /** The `PassBook-Version` date a call pinned. */
  version?: string;
  /** Rows newer than this id (UUIDv7, so newer sorts higher). */
  after?: string;
}

function where(orgId: string, f: LogFilter, now: number, cursor?: string) {
  const sql = ['org_id = ?', 'at >= ?', "mode = 'test'"];
  const params: SqlValue[] = [orgId, now - LOG_META_MS];
  const add = (clause: string, ...values: SqlValue[]) => {
    sql.push(clause);
    params.push(...values);
  };
  if (f.keyId) add('key_id = ?', f.keyId);
  if (f.passId) add('resource_id = ?', f.passId);
  if (f.version) add('api_version = ?', f.version);
  if (f.code) add('code = ?', f.code);
  if (f.method) add('method = ?', f.method);
  if (f.path) add('instr(path, ?) > 0', f.path);
  if (f.status?.endsWith('xx')) {
    const hundred = Number(f.status[0]) * 100;
    add('status >= ? AND status < ?', hundred, hundred + 100);
  } else if (f.status) add('status = ?', Number(f.status));
  if (f.source === 'key') add('via IS NULL');
  else if (f.source === 'try') add("via = 'try'");
  if (f.portal === 'hide') add("(client IS NULL OR client <> 'portal')");
  if (f.after) add('id > ?', f.after);
  if (cursor) add('id < ?', cursor);
  return { sql: sql.join(' AND '), params };
}

/** A body is readable for 24 hours; the column may outlive that until the purge, the read never shows it. */
const readable = (now: number) => `(has_bodies = 1 AND at >= ${now - LOG_BODY_MS})`;

const LIST_COLUMNS = (now: number) =>
  `id, org_id, key_id, via, client, mode, request_id, method, route, path, query, status, code, duration_ms, at,
   resource_id, api_version, flags, bodies_truncated,
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
    `SELECT id, org_id, key_id, via, client, mode, request_id, method, route, path, query, status, code, duration_ms, at,
       resource_id, api_version, flags, bodies_truncated,
       CASE WHEN ${readable(now)} THEN 1 ELSE 0 END AS has_bodies,
       CASE WHEN ${readable(now)} THEN request_body END AS request_body,
       CASE WHEN ${readable(now)} THEN response_body END AS response_body
     FROM request_log WHERE org_id = ? AND mode = 'test' AND (id = ? OR request_id = ? COLLATE NOCASE) AND at >= ?
     ORDER BY id = ? DESC, id DESC LIMIT 1`,
    [orgId, id, id, now - LOG_META_MS, id],
  );

/** Calls since `since` in `width` ms buckets (`b` 0 is the oldest), without the portal's own background reads. */
export const callBuckets = (db: D1Database, orgId: string, since: number, width: number) =>
  all<{ b: number; n: number }>(
    db,
    `SELECT CAST((at - ?) / ? AS INTEGER) AS b, count(*) AS n FROM request_log
     WHERE org_id = ? AND at >= ? AND (client IS NULL OR client <> 'portal') GROUP BY b`,
    [since, width, orgId, since],
  );

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

/** Blanks every stored body of one org: its admin turned recording off. */
export const purgeOrgBodies = async (db: D1Database, orgId: string) =>
  (
    await run(
      db,
      `UPDATE request_log SET request_body = NULL, response_body = NULL, has_bodies = 0
       WHERE org_id = ? AND has_bodies = 1`,
      [orgId],
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
