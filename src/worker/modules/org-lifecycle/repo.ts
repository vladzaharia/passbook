import { all, first, type SqlValue, stmt } from '../../platform/db.ts';
import { platformAdminSessionParams, platformAdminSessionSql } from '../passes/repo-authority.ts';

export interface LifecycleRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  default_identity_id: string | null;
  closed_at: number | null;
  purge_after: number | null;
  purge_started_at: number | null;
  purged_at: number | null;
  closed_identity_id: string | null;
  held: number;
}

const HELD = `EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = orgs.id AND h.released_at IS NULL)`;
const SELECT = `SELECT id, slug, name, status, default_identity_id, closed_at, purge_after, purge_started_at,
  purged_at, closed_identity_id, ${HELD} AS held FROM orgs`;

export const lifecycleRow = (db: D1Database, id: string) =>
  first<LifecycleRow>(db, `${SELECT} WHERE id = ?`, [id]);

/** Closed orgs, soonest purge first. */
export const closedOrgs = (db: D1Database, limit: number) =>
  all<LifecycleRow>(
    db,
    `${SELECT} WHERE status = 'deleted' AND closed_at IS NOT NULL AND purged_at IS NULL
     ORDER BY purge_after, id LIMIT ?`,
    [limit],
  );

/** Closed orgs whose window is over, no purge running or done. A hold is checked again by the purge. */
export const purgeDue = (db: D1Database, now: number, limit: number) =>
  all<LifecycleRow>(
    db,
    `${SELECT} WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= ?
       AND purged_at IS NULL AND NOT ${HELD} ORDER BY purge_after, id LIMIT ?`,
    [now, limit],
  );

/** An admin of the org (any org status) or a platform admin: the fence repeated at the write. */
export type LifecycleActor =
  | { kind: 'platform'; userId: string; sessionId: string }
  | { kind: 'owner'; userId: string; sessionId: string };

const liveSession = `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL
    AND s.expires_at > ? AND s.idle_expires_at > ?)`;

const orgAdminSql = `EXISTS (SELECT 1 FROM org_memberships m, json_each(m.roles) r
  WHERE m.org_id = ? AND m.user_id = ? AND m.revoked_at IS NULL AND r.value = 'org_admin')`;

export function actorFence(
  actor: LifecycleActor,
  orgId: string,
  now: number,
): { sql: string; params: SqlValue[] } {
  if (actor.kind === 'platform')
    return { sql: platformAdminSessionSql, params: platformAdminSessionParams(actor, now) };
  return {
    sql: `(${liveSession} AND ${orgAdminSql})`,
    params: [actor.sessionId, actor.userId, now, now, orgId, actor.userId],
  };
}

/** An org admin of `orgId`, read for the route's 403 and the notice list; the write repeats the fence. */
export const isOrgAdmin = async (db: D1Database, orgId: string, userId: string) =>
  (await first(db, `SELECT 1 AS x WHERE ${orgAdminSql}`, [orgId, userId])) !== null;

export interface ExportRow {
  id: string;
  org_id: string;
  requested_by: string | null;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  r2_key: string | null;
  bytes: number | null;
  entities: string | null;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
  expires_at: number | null;
}

const EXPORT_COLUMNS =
  'id, org_id, requested_by, state, r2_key, bytes, entities, error_code, created_at, finished_at, expires_at';

/** One open export per org; the row lands only while the actor's fence holds and the org is not in purge. */
export async function insertExport(
  db: D1Database,
  row: { id: string; orgId: string; now: number },
  actor: LifecycleActor,
): Promise<boolean> {
  const fence = actorFence(actor, row.orgId, row.now);
  const result = await stmt(
    db,
    `INSERT INTO org_exports (id, org_id, requested_by, state, created_at)
     SELECT ?, o.id, ?, 'queued', ? FROM orgs o
     WHERE o.id = ? AND o.purge_started_at IS NULL AND o.purged_at IS NULL AND ${fence.sql}
       AND NOT EXISTS (SELECT 1 FROM org_exports e WHERE e.org_id = o.id AND e.state IN ('queued', 'running'))`,
    [row.id, actor.userId, row.now, row.orgId, ...fence.params],
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export const exportRow = (db: D1Database, orgId: string, id: string) =>
  first<ExportRow>(db, `SELECT ${EXPORT_COLUMNS} FROM org_exports WHERE id = ? AND org_id = ?`, [
    id,
    orgId,
  ]);

export const exportRows = (db: D1Database, orgId: string) =>
  all<ExportRow>(
    db,
    `SELECT ${EXPORT_COLUMNS} FROM org_exports WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
    [orgId],
  );

/** queued to running; false when another run owns it or it is done (an idempotent re-run). */
export async function claimExport(db: D1Database, id: string): Promise<boolean> {
  const r = await stmt(
    db,
    "UPDATE org_exports SET state = 'running', error_code = NULL WHERE id = ? AND state IN ('queued', 'running')",
    [id],
  ).run();
  return (r.meta.changes ?? 0) === 1;
}

export async function finishExport(
  db: D1Database,
  id: string,
  done: { r2Key: string; bytes: number; entities: string; now: number; expiresAt: number },
): Promise<void> {
  await stmt(
    db,
    `UPDATE org_exports SET state = 'ready', r2_key = ?, bytes = ?, entities = ?, finished_at = ?, expires_at = ?
     WHERE id = ? AND state = 'running'`,
    [done.r2Key, done.bytes, done.entities, done.now, done.expiresAt, id],
  ).run();
}

export async function failExport(
  db: D1Database,
  id: string,
  code: string,
  now: number,
): Promise<void> {
  await stmt(
    db,
    "UPDATE org_exports SET state = 'failed', error_code = ?, finished_at = ? WHERE id = ? AND state IN ('queued', 'running')",
    [code, now, id],
  ).run();
}

/** The export is still being built: a purge deletes the row, and its workflow must then stop writing. */
export async function exportRunning(db: D1Database, id: string): Promise<boolean> {
  return (
    (await first(db, "SELECT 1 AS x FROM org_exports WHERE id = ? AND state = 'running'", [id])) !==
    null
  );
}

export const expiredExports = (db: D1Database, now: number, limit: number) =>
  all<ExportRow>(
    db,
    `SELECT ${EXPORT_COLUMNS} FROM org_exports WHERE state = 'ready' AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
    [now, limit],
  );

export async function markExpired(db: D1Database, id: string): Promise<void> {
  await stmt(
    db,
    "UPDATE org_exports SET state = 'expired', r2_key = NULL WHERE id = ? AND state = 'ready'",
    [id],
  ).run();
}

/** Running exports older than `before` (a lost workflow): failed so the org can ask again. */
export async function failStuckExports(db: D1Database, before: number, now: number) {
  const r = await stmt(
    db,
    `UPDATE org_exports SET state = 'failed', error_code = 'ORG_EXPORT_STUCK', finished_at = ?
     WHERE state IN ('queued', 'running') AND created_at < ?`,
    [now, before],
  ).run();
  return r.meta.changes ?? 0;
}

/** The caller's fence holds now: a live session, and the role of a platform or org admin. */
export async function actorHolds(
  db: D1Database,
  actor: LifecycleActor,
  orgId: string,
  now: number,
): Promise<boolean> {
  const fence = actorFence(actor, orgId, now);
  return (await first(db, `SELECT 1 AS x WHERE ${fence.sql}`, fence.params)) !== null;
}

/** The identity still belongs to the org, so a reopen can make it the default again. */
export async function identityBelongs(db: D1Database, orgId: string, id: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS x FROM signing_identities WHERE id = ? AND org_id = ?', [
      id,
      orgId,
    ])) !== null
  );
}

export async function exportOrgId(db: D1Database, id: string): Promise<string | null> {
  return (
    (await first<{ org_id: string }>(db, 'SELECT org_id FROM org_exports WHERE id = ?', [id]))
      ?.org_id ?? null
  );
}
