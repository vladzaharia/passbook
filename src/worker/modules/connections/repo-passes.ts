import { all, batch, chunk, first, placeholders, run, stmt } from '../../platform/db.ts';
import type { JobOf } from '../../jobs/types.ts';

// Passes (sync bookkeeping only; content changes go through passes/service.ts)

export interface SyncPass {
  id: string;
  orgId: string;
  mode: 'live' | 'test';
  status: 'active' | 'voided';
  version: number;
  ownerUserId: string | null;
  linkGeneration: number;
  deletedAt: number | null;
  removedAt: number | null;
  connectionId: string | null;
  externalRef: string | null;
  templateId: string;
  templateVersion: string;
  personalization: Record<string, unknown>;
}

interface SyncPassSql {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  status: 'active' | 'voided';
  version: number;
  owner_user_id: string | null;
  link_generation: number;
  deleted_at: number | null;
  removed_at: number | null;
  connection_id: string | null;
  external_ref: string | null;
  template_id: string;
  template_version: string;
  personalization: string;
}

const PASS_COLUMNS =
  'id, org_id, mode, status, version, owner_user_id, link_generation, deleted_at, removed_at, connection_id, external_ref, template_id, template_version, personalization';

function toPass(r: SyncPassSql): SyncPass {
  return {
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    status: r.status,
    version: r.version,
    ownerUserId: r.owner_user_id,
    linkGeneration: r.link_generation,
    deletedAt: r.deleted_at,
    removedAt: r.removed_at,
    connectionId: r.connection_id,
    externalRef: r.external_ref,
    templateId: r.template_id,
    templateVersion: r.template_version,
    personalization: JSON.parse(r.personalization) as Record<string, unknown>,
  };
}

export async function getPassByRef(
  db: D1Database,
  orgId: string,
  connectionId: string,
  ref: string,
): Promise<SyncPass | null> {
  const r = await first<SyncPassSql>(
    db,
    `SELECT ${PASS_COLUMNS} FROM passes
     WHERE org_id = ? AND mode = 'live' AND connection_id = ? AND external_ref = ?
       AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL
       AND test_data_quarantined = 0 LIMIT 1`,
    [orgId, connectionId, ref],
  );
  return r ? toPass(r) : null;
}

/** A legacy ineligible binding still occupies the unique (org, connection, ref) key. */
export async function hasBinding(
  db: D1Database,
  orgId: string,
  connectionId: string,
  ref: string,
): Promise<boolean> {
  return (await first(
    db,
    'SELECT 1 FROM passes WHERE org_id = ? AND connection_id = ? AND external_ref = ? LIMIT 1',
    [orgId, connectionId, ref],
  )) !== null;
}

/** Active passes linked to `refs`, keyed by ref. */
export async function listPassesByRefs(
  db: D1Database,
  orgId: string,
  connectionId: string,
  refs: string[],
): Promise<Map<string, SyncPass>> {
  const out = new Map<string, SyncPass>();
  for (const part of chunk([...new Set(refs)], 80)) {
    const rows = await all<SyncPassSql>(
      db,
      `SELECT ${PASS_COLUMNS} FROM passes
       WHERE org_id = ? AND mode = 'live' AND connection_id = ? AND status = 'active'
         AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
         AND external_ref IN (${placeholders(part.length)})`,
      [orgId, connectionId, ...part],
    );
    for (const r of rows)
      if (r.external_ref && !out.has(r.external_ref)) out.set(r.external_ref, toPass(r));
  }
  return out;
}

export async function getPassById(db: D1Database, passId: string): Promise<SyncPass | null> {
  const r = await first<SyncPassSql>(db, `SELECT ${PASS_COLUMNS} FROM passes WHERE id = ? AND test_data_quarantined = 0`, [
    passId,
  ]);
  return r ? toPass(r) : null;
}

/** Active linked passes whose next_sync_at has come (never-synced first). */
export async function listDuePassRefs(
  db: D1Database,
  orgId: string,
  connectionId: string,
  now: number,
  limit: number,
): Promise<string[]> {
  const rows = await all<{ external_ref: string }>(
    db,
    `SELECT external_ref FROM passes
     WHERE org_id = ? AND mode = 'live' AND connection_id = ? AND external_ref IS NOT NULL
       AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
       AND (next_sync_at IS NULL OR next_sync_at <= ?)
     ORDER BY next_sync_at IS NOT NULL, next_sync_at LIMIT ?`,
    [orgId, connectionId, now, limit],
  );
  return rows.map((r) => r.external_ref);
}

/** The pass and connection values captured before an upstream request. */
export interface SyncSnapshot {
  passId: string;
  orgId: string;
  mode: 'live';
  status: 'active';
  expectedVersion: number;
  ownerUserId: string | null;
  linkGeneration: number;
  connectionId: string;
  externalRef: string;
  generation: number;
}

const SYNC_GUARD = `id = ? AND org_id = ? AND mode = ? AND status = ?
  AND version = ? AND owner_user_id IS ? AND link_generation = ? AND connection_id = ? AND external_ref = ?
  AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
  AND EXISTS (SELECT 1 FROM connections c JOIN orgs o ON o.id = c.org_id
    WHERE c.id = ? AND c.org_id = ? AND c.enabled = 1
      AND c.generation = ? AND o.status = 'active')`;

function syncParams(p: SyncSnapshot): (string | number | null)[] {
  return [
    p.passId, p.orgId, p.mode, p.status, p.expectedVersion, p.ownerUserId, p.linkGeneration, p.connectionId, p.externalRef,
    p.connectionId, p.orgId, p.generation,
  ];
}

export async function markPassSynced(
  db: D1Database,
  p: SyncSnapshot & { now: number; nextSyncAt: number | null },
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE passes SET last_synced_at = ?, sync_error_code = NULL, sync_failures = 0, next_sync_at = ?
     WHERE ${SYNC_GUARD}`,
    [p.now, p.nextSyncAt, ...syncParams(p)],
  );
  return result.changes === 1;
}

export async function markPassSyncError(
  db: D1Database,
  p: SyncSnapshot & { code: string; nextSyncAt: number | null },
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE passes SET sync_error_code = ?, sync_failures = sync_failures + 1, next_sync_at = ?
     WHERE ${SYNC_GUARD}`,
    [p.code, p.nextSyncAt, ...syncParams(p)],
  );
  return result.changes === 1;
}

export type RefreshSnapshot = Pick<
  JobOf<'pass.refresh'>,
  'passId' | 'orgId' | 'mode' | 'passVersion' | 'status' | 'ownerUserId' | 'linkGeneration' | 'connectionId' | 'externalRef' | 'generation'
>;

const REFRESH_GUARD = `id = ? AND org_id = ? AND mode = ? AND status = ? AND version = ?
  AND owner_user_id IS ? AND link_generation = ? AND connection_id IS ? AND external_ref IS ?
  AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = ? AND o.status = 'active')
  AND (? IS NULL OR EXISTS (SELECT 1 FROM connections c
    WHERE c.id = ? AND c.org_id = ? AND c.enabled = 1 AND c.generation = ?))`;

function refreshParams(p: RefreshSnapshot): (string | number | null)[] {
  return [
    p.passId, p.orgId, p.mode, p.status, p.passVersion, p.ownerUserId, p.linkGeneration, p.connectionId, p.externalRef,
    p.orgId, p.connectionId, p.connectionId, p.orgId, p.generation,
  ];
}

/** Runtime checks also reject old queue messages and inconsistent bindings. */
export function validRefreshSnapshot(p: RefreshSnapshot): boolean {
  if (!p.orgId || (p.mode !== 'live' && p.mode !== 'test') ||
      !Number.isInteger(p.passVersion) || p.passVersion < 1 ||
      !Number.isInteger(p.linkGeneration) || p.linkGeneration < 1 ||
      (p.status !== 'active' && p.status !== 'voided') ||
      (p.ownerUserId !== null && typeof p.ownerUserId !== 'string')) return false;
  if (p.connectionId === null) return p.externalRef === null && p.generation === null;
  return typeof p.connectionId === 'string' && p.connectionId.length > 0 &&
    p.mode === 'live' && p.status === 'active' &&
    typeof p.externalRef === 'string' && p.externalRef.length > 0 &&
    Number.isInteger(p.generation) && (p.generation ?? 0) > 0;
}

export async function refreshSnapshotCurrent(db: D1Database, p: RefreshSnapshot): Promise<boolean> {
  if (!validRefreshSnapshot(p)) return false;
  return (await first(db, `SELECT 1 FROM passes WHERE ${REFRESH_GUARD}`, refreshParams(p))) !== null;
}

export async function templateScope(
  db: D1Database,
  templateId: string,
): Promise<{ orgId: string | null; status: string; activeVersion: string | null } | null> {
  const r = await first<{ org_id: string | null; status: string; active_version: string | null }>(
    db,
    'SELECT org_id, status, active_version FROM templates WHERE id = ?',
    [templateId],
  );
  return r ? { orgId: r.org_id, status: r.status, activeVersion: r.active_version } : null;
}

// Webhook events and inbox

export interface InboxItem {
  ref: string;
  record: Record<string, unknown> | null;
  deleted: boolean;
}

/** False when the event id was seen before. */
export async function insertWebhookEvent(
  db: D1Database,
  connectionId: string,
  eventId: string,
  now: number,
): Promise<boolean> {
  const r = await run(
    db,
    'INSERT OR IGNORE INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
    [connectionId, eventId, now],
  );
  return r.changes === 1;
}

export async function insertInbox(
  db: D1Database,
  connectionId: string,
  eventId: string,
  items: InboxItem[],
  now: number,
): Promise<void> {
  const statements = items.map((i) =>
    stmt(
      db,
      `INSERT OR REPLACE INTO connection_inbox (connection_id, event_id, ref, record, deleted, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [connectionId, eventId, i.ref, i.record ? JSON.stringify(i.record) : null, i.deleted, now],
    ),
  );
  for (const part of chunk(statements, 50)) await batch(db, part);
}

export async function deleteWebhookEvent(
  db: D1Database,
  connectionId: string,
  eventId: string,
): Promise<void> {
  await run(db, 'DELETE FROM webhook_events WHERE connection_id = ? AND event_id = ?', [
    connectionId,
    eventId,
  ]);
}

export async function getInbox(
  db: D1Database,
  connectionId: string,
  eventId: string,
): Promise<InboxItem[]> {
  const rows = await all<{ ref: string; record: string | null; deleted: number }>(
    db,
    'SELECT ref, record, deleted FROM connection_inbox WHERE connection_id = ? AND event_id = ?',
    [connectionId, eventId],
  );
  return rows.map((r) => ({
    ref: r.ref,
    record: r.record ? (JSON.parse(r.record) as Record<string, unknown>) : null,
    deleted: r.deleted === 1,
  }));
}

/** Passes bound to each connection (list rows). */
export async function passCountsFor(
  db: D1Database,
  connectionIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const ids of chunk(connectionIds)) {
    const rows = await all<{ id: string; n: number }>(
      db,
      `SELECT p.connection_id AS id, count(*) AS n FROM passes p
       JOIN connections c ON c.id = p.connection_id AND c.org_id = p.org_id
       WHERE p.connection_id IN (${placeholders(ids.length)}) AND p.mode = 'live'
         AND p.test_data_quarantined = 0 GROUP BY p.connection_id`,
      ids,
    );
    for (const r of rows) out.set(r.id, r.n);
  }
  return out;
}
