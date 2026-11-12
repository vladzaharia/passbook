import type { Json } from '../../../shared/contracts/common.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ConnectionActor,
  commitOrNull,
  connectionGrant,
  connectionIs,
  rowCount,
  workflowTracked,
} from './repo-grants.ts';
import { validCredentialKeysetCommitment } from './repo-passes.ts';
import { type ConnectionSql, toRow } from './repo-row.ts';

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

/** Creates the connection in the actor's org. `generation` starts at 1 (trigger-owned afterwards). */
const INSERT_COLUMNS = [
  'id',
  'connector_type',
  'connector_version',
  'name',
  'config',
  'credential_id',
  'webhook_credential_id',
  'mapping',
  'default_template_id',
  'holder_email_field',
  'auto_create',
  'auto_email',
  'on_missing',
  'mode',
  'interval_seconds',
  'max_concurrency',
  'requests_per_minute',
  'enabled',
  'health',
  'consecutive_failures',
  'next_run_at',
  'created_at',
  'updated_at',
];

function insertValues(row: ConnectionRow): SqlValue[] {
  return [
    row.id,
    row.connectorType,
    row.connectorVersion,
    row.name,
    JSON.stringify(row.config),
    row.credentialId,
    row.webhookCredentialId,
    row.mapping ? JSON.stringify(row.mapping) : null,
    row.defaultTemplateId,
    row.holderEmailField,
    row.autoCreate ? 1 : 0,
    row.autoEmail ? 1 : 0,
    row.onMissing,
    row.mode,
    row.intervalSeconds,
    row.maxConcurrency,
    row.requestsPerMinute,
    row.enabled ? 1 : 0,
    row.health,
    row.consecutiveFailures,
    row.nextRunAt,
    row.createdAt,
    row.updatedAt,
  ];
}

export async function insertConnection(
  ctx: ServiceContext,
  row: ConnectionRow,
  actor: ConnectionActor,
): Promise<void> {
  const g = connectionGrant(ctx, actor, 'create', [], row.id);
  g.insertSelect('connections', INSERT_COLUMNS, insertValues(row));
  await g.commit();
}

export async function getConnection(db: D1Database, id: string): Promise<ConnectionRow | null> {
  const r = await first<ConnectionSql>(db, 'SELECT * FROM connections WHERE id = ?', [id]);
  return r ? toRow(r) : null;
}

/** What a connection write requires of the row it changes. Absent fields are not compared. */
export interface PatchGuard {
  actor: ConnectionActor;
  generation?: number;
  /** The sync mode the caller read. */
  syncMode?: Mode;
  /** Refuse unless the connection is enabled. */
  enabled?: boolean;
  /** The sync workflow that pinned this credential keyset must still be tracked. */
  keyset?: { commitment: string; instanceId: string } | { commitment: string; source: 'webhook' };
}

/**
 * Applies a patch to the connection in the actor's org. Returns 1 when it applied, 0 when the
 * connection no longer matches the guard (changed, disabled, gone, or its org was suspended for a job).
 * Epoch columns are trigger-owned: a patch of a config column moves `generation` by itself.
 */
export async function patchConnection(
  ctx: ServiceContext,
  id: string,
  patch: ConnectionPatch,
  guard: PatchGuard,
): Promise<number> {
  const keys = Object.keys(patch) as (keyof typeof COLUMNS)[];
  if (keys.length === 0) return 0;
  const checks: Check[] = [
    connectionIs({
      id,
      ...(guard.generation === undefined ? {} : { generation: guard.generation }),
      ...(guard.syncMode === undefined ? {} : { syncMode: guard.syncMode }),
      ...(guard.enabled ? { enabled: true } : {}),
    }),
  ];
  const keyset = guard.keyset;
  if (keyset !== undefined) {
    if (!validCredentialKeysetCommitment(keyset.commitment)) return 0;
    if ('instanceId' in keyset) {
      if (typeof keyset.instanceId !== 'string' || !keyset.instanceId) return 0;
      checks.push(workflowTracked(keyset.instanceId, id, keyset.commitment));
    } else if (keyset.source !== 'webhook') return 0;
  }
  const g = connectionGrant(ctx, guard.actor, 'update', checks, id);
  const set: Record<string, SqlValue> = {};
  for (const k of keys) set[COLUMNS[k]] = encode(patch[k] as SqlValue | object);
  g.update('connections', { set, where: { id }, returning: ['id'] });
  const results = await commitOrNull(g, guard.actor);
  return results ? rowCount(results.at(-1)) : 0;
}

/** True when this call deleted the connection (RETURNING; D1 counts cascaded children in `changes`). */
export async function deleteConnection(
  ctx: ServiceContext,
  id: string,
  actor: ConnectionActor,
  generation?: number,
): Promise<boolean> {
  const g = connectionGrant(
    ctx,
    actor,
    'delete',
    [connectionIs({ id, ...(generation === undefined ? {} : { generation }) })],
    id,
  );
  g.delete('connections', { where: { id }, returning: ['id'] });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}
