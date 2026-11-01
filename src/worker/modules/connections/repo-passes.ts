import { all, batch, chunk, first, placeholders, run, stmt } from '../../platform/db.ts';

// Passes (sync bookkeeping only; content changes go through passes/service.ts)

export interface SyncPass {
  id: string;
  orgId: string;
  connectionId: string | null;
  externalRef: string | null;
  templateId: string;
  templateVersion: string;
  personalization: Record<string, unknown>;
}

interface SyncPassSql {
  id: string;
  org_id: string;
  connection_id: string | null;
  external_ref: string | null;
  template_id: string;
  template_version: string;
  personalization: string;
}

const PASS_COLUMNS =
  'id, org_id, connection_id, external_ref, template_id, template_version, personalization';

function toPass(r: SyncPassSql): SyncPass {
  return {
    id: r.id,
    orgId: r.org_id,
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
     WHERE org_id = ? AND connection_id = ? AND external_ref = ? AND status = 'active' LIMIT 1`,
    [orgId, connectionId, ref],
  );
  return r ? toPass(r) : null;
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
       WHERE org_id = ? AND connection_id = ? AND status = 'active'
         AND external_ref IN (${placeholders(part.length)})`,
      [orgId, connectionId, ...part],
    );
    for (const r of rows)
      if (r.external_ref && !out.has(r.external_ref)) out.set(r.external_ref, toPass(r));
  }
  return out;
}

export async function getPassById(db: D1Database, passId: string): Promise<SyncPass | null> {
  const r = await first<SyncPassSql>(db, `SELECT ${PASS_COLUMNS} FROM passes WHERE id = ?`, [
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
     WHERE org_id = ? AND connection_id = ? AND external_ref IS NOT NULL AND status = 'active'
       AND (next_sync_at IS NULL OR next_sync_at <= ?)
     ORDER BY next_sync_at IS NOT NULL, next_sync_at LIMIT ?`,
    [orgId, connectionId, now, limit],
  );
  return rows.map((r) => r.external_ref);
}

export async function markPassSynced(
  db: D1Database,
  p: { passId: string; connectionId: string; now: number; nextSyncAt: number | null },
): Promise<void> {
  await run(
    db,
    `UPDATE passes SET last_synced_at = ?, sync_error_code = NULL, sync_failures = 0, next_sync_at = ?
     WHERE id = ? AND connection_id = ?`,
    [p.now, p.nextSyncAt, p.passId, p.connectionId],
  );
}

export async function markPassSyncError(
  db: D1Database,
  p: { passId: string; connectionId: string; code: string; nextSyncAt: number | null },
): Promise<void> {
  await run(
    db,
    `UPDATE passes SET sync_error_code = ?, sync_failures = sync_failures + 1, next_sync_at = ?
     WHERE id = ? AND connection_id = ?`,
    [p.code, p.nextSyncAt, p.passId, p.connectionId],
  );
}

export async function setLastRefreshed(db: D1Database, passId: string, now: number): Promise<void> {
  await run(db, 'UPDATE passes SET last_refreshed_at = ? WHERE id = ?', [now, passId]);
}

export async function templateScope(
  db: D1Database,
  templateId: string,
): Promise<{ orgId: string | null; status: string } | null> {
  const r = await first<{ org_id: string | null; status: string }>(
    db,
    'SELECT org_id, status FROM templates WHERE id = ?',
    [templateId],
  );
  return r ? { orgId: r.org_id, status: r.status } : null;
}

export async function orgExists(db: D1Database, orgId: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS x FROM orgs WHERE id = ?', [orgId])) !== null;
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
      `SELECT connection_id AS id, count(*) AS n FROM passes
       WHERE connection_id IN (${placeholders(ids.length)}) GROUP BY connection_id`,
      ids,
    );
    for (const r of rows) out.set(r.id, r.n);
  }
  return out;
}
