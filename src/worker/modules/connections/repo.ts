import type { Json } from '../../../shared/contracts/common.ts';
import { all, first, likeEscape, run, type SqlValue } from '../../platform/db.ts';

export type OnMissing = 'keep' | 'flag' | 'void';
export type Mode = 'poll' | 'webhook' | 'hybrid' | 'manual' | 'snapshot';
export type Health = 'unknown' | 'healthy' | 'degraded' | 'failing' | 'paused' | 'disabled';

export interface MappingEntry {
  from: string;
  transform?: { kind: string; options?: Record<string, Json> | undefined } | undefined;
}

export interface ConnectionRow {
  id: string;
  orgId: string;
  connectorType: string;
  connectorVersion: number;
  name: string;
  config: Record<string, Json>;
  credentialId: string | null;
  webhookCredentialId: string | null;
  mapping: Record<string, MappingEntry> | null;
  defaultTemplateId: string | null;
  holderEmailField: string | null;
  autoCreate: boolean;
  autoEmail: boolean;
  onMissing: OnMissing;
  mode: Mode;
  intervalSeconds: number | null;
  maxConcurrency: number | null;
  requestsPerMinute: number | null;
  enabled: boolean;
  generation: number;
  health: Health;
  consecutiveFailures: number;
  breakerOpenUntil: number | null;
  cursor: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ConnectionSql {
  id: string;
  org_id: string;
  connector_type: string;
  connector_version: number;
  name: string;
  config: string;
  credential_id: string | null;
  webhook_credential_id: string | null;
  mapping: string | null;
  default_template_id: string | null;
  holder_email_field: string | null;
  auto_create: number;
  auto_email: number;
  on_missing: OnMissing;
  mode: Mode;
  interval_seconds: number | null;
  max_concurrency: number | null;
  requests_per_minute: number | null;
  enabled: number;
  generation: number;
  health: Health;
  consecutive_failures: number;
  breaker_open_until: number | null;
  cursor: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

function toRow(r: ConnectionSql): ConnectionRow {
  return {
    id: r.id,
    orgId: r.org_id,
    connectorType: r.connector_type,
    connectorVersion: r.connector_version,
    name: r.name,
    config: JSON.parse(r.config) as Record<string, Json>,
    credentialId: r.credential_id,
    webhookCredentialId: r.webhook_credential_id,
    mapping: r.mapping ? (JSON.parse(r.mapping) as Record<string, MappingEntry>) : null,
    defaultTemplateId: r.default_template_id,
    holderEmailField: r.holder_email_field,
    autoCreate: r.auto_create === 1,
    autoEmail: r.auto_email === 1,
    onMissing: r.on_missing,
    mode: r.mode,
    intervalSeconds: r.interval_seconds,
    maxConcurrency: r.max_concurrency,
    requestsPerMinute: r.requests_per_minute,
    enabled: r.enabled === 1,
    generation: r.generation,
    health: r.health,
    consecutiveFailures: r.consecutive_failures,
    breakerOpenUntil: r.breaker_open_until,
    cursor: r.cursor,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastSuccessAt: r.last_success_at,
    lastErrorCode: r.last_error_code,
    lastErrorAt: r.last_error_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Patchable columns; the SQL column name is fixed here, never taken from input. */
const COLUMNS = {
  name: 'name',
  config: 'config',
  connectorVersion: 'connector_version',
  credentialId: 'credential_id',
  webhookCredentialId: 'webhook_credential_id',
  mapping: 'mapping',
  defaultTemplateId: 'default_template_id',
  holderEmailField: 'holder_email_field',
  autoCreate: 'auto_create',
  autoEmail: 'auto_email',
  onMissing: 'on_missing',
  mode: 'mode',
  intervalSeconds: 'interval_seconds',
  maxConcurrency: 'max_concurrency',
  requestsPerMinute: 'requests_per_minute',
  enabled: 'enabled',
  generation: 'generation',
  health: 'health',
  consecutiveFailures: 'consecutive_failures',
  breakerOpenUntil: 'breaker_open_until',
  cursor: 'cursor',
  nextRunAt: 'next_run_at',
  lastRunAt: 'last_run_at',
  lastSuccessAt: 'last_success_at',
  lastErrorCode: 'last_error_code',
  lastErrorAt: 'last_error_at',
  updatedAt: 'updated_at',
} as const;
export type ConnectionPatch = { -readonly [K in keyof typeof COLUMNS]?: SqlValue | object };

function encode(value: SqlValue | object): SqlValue {
  return value !== null &&
    typeof value === 'object' &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
    ? JSON.stringify(value)
    : (value as SqlValue);
}

export async function insertConnection(db: D1Database, row: ConnectionRow): Promise<void> {
  await run(
    db,
    `INSERT INTO connections (id, org_id, connector_type, connector_version, name, config, credential_id,
       webhook_credential_id, mapping, default_template_id, holder_email_field, auto_create, auto_email,
       on_missing, mode, interval_seconds, max_concurrency, requests_per_minute, enabled, generation,
       health, consecutive_failures, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.orgId,
      row.connectorType,
      row.connectorVersion,
      row.name,
      JSON.stringify(row.config),
      row.credentialId,
      row.webhookCredentialId,
      row.mapping ? JSON.stringify(row.mapping) : null,
      row.defaultTemplateId,
      row.holderEmailField,
      row.autoCreate,
      row.autoEmail,
      row.onMissing,
      row.mode,
      row.intervalSeconds,
      row.maxConcurrency,
      row.requestsPerMinute,
      row.enabled,
      row.generation,
      row.health,
      row.consecutiveFailures,
      row.nextRunAt,
      row.createdAt,
      row.updatedAt,
    ],
  );
}

export async function getConnection(db: D1Database, id: string): Promise<ConnectionRow | null> {
  const r = await first<ConnectionSql>(db, 'SELECT * FROM connections WHERE id = ?', [id]);
  return r ? toRow(r) : null;
}

export async function listConnections(
  db: D1Database,
  q: {
    orgId?: string | undefined;
    health?: Health | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<ConnectionRow[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const term = q.q?.trim().toLowerCase();
  if (term) {
    where.push("lower(name) LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(term)}%`);
  }
  if (q.orgId) {
    where.push('org_id = ?');
    params.push(q.orgId);
  }
  if (q.health) {
    where.push('health = ?');
    params.push(q.health);
  }
  if (q.cursor) {
    where.push('id < ?');
    params.push(q.cursor);
  }
  const rows = await all<ConnectionSql>(
    db,
    `SELECT * FROM connections ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    [...params, q.limit],
  );
  return rows.map(toRow);
}

/** Applies a patch; `ifGeneration` makes the write a no-op when the run is stale. Returns rows changed. */
export async function patchConnection(
  db: D1Database,
  id: string,
  patch: ConnectionPatch,
  ifGeneration?: number,
): Promise<number> {
  const keys = Object.keys(patch) as (keyof typeof COLUMNS)[];
  if (keys.length === 0) return 0;
  const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(', ');
  const params: SqlValue[] = keys.map((k) => encode(patch[k] as SqlValue | object));
  params.push(id);
  let sql = `UPDATE connections SET ${sets} WHERE id = ?`;
  if (ifGeneration !== undefined) {
    sql += ' AND generation = ?';
    params.push(ifGeneration);
  }
  return (await run(db, sql, params)).changes;
}

export async function deleteConnection(db: D1Database, id: string): Promise<void> {
  await run(db, 'DELETE FROM connections WHERE id = ?', [id]);
}

export async function getGeneration(db: D1Database, id: string): Promise<number | null> {
  const r = await first<{ generation: number }>(
    db,
    'SELECT generation FROM connections WHERE id = ?',
    [id],
  );
  return r?.generation ?? null;
}

export async function listDueConnections(db: D1Database, now: number, limit: number) {
  const rows = await all<ConnectionSql>(
    db,
    `SELECT c.* FROM connections c JOIN orgs o ON o.id = c.org_id
     WHERE c.enabled = 1 AND o.status = 'active'
       AND c.next_run_at IS NOT NULL AND c.next_run_at <= ?
       AND (c.breaker_open_until IS NULL OR c.breaker_open_until <= ?)
     ORDER BY c.next_run_at LIMIT ?`,
    [now, now, limit],
  );
  return rows.map(toRow);
}

export async function summary(db: D1Database) {
  const counts = await all<{ health: string; n: number }>(
    db,
    'SELECT health, COUNT(*) AS n FROM connections GROUP BY health',
  );
  const attention = await all<{
    id: string;
    org_id: string;
    name: string;
    health: Health;
    last_error_code: string | null;
    last_error_at: number | null;
  }>(
    db,
    `SELECT id, org_id, name, health, last_error_code, last_error_at FROM connections
     WHERE enabled = 1 AND health IN ('failing', 'degraded') ORDER BY last_error_at DESC LIMIT 20`,
  );
  return { counts, attention };
}
