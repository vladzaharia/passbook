import type { BroadcastKind, BroadcastState } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, placeholders, run, type SqlValue, stmt } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { readMode, type ScopeArg, scopeOrg } from '../passes/scope.ts';

export type { CountRow, ItemRow } from './repo-outcomes.ts';
export { countItems, handledPassIds, insertItems } from './repo-outcomes.ts';
export type { BroadcastKind, BroadcastState };

export interface BroadcastRow {
  id: string;
  org_id: string;
  mode: Mode;
  kind: BroadcastKind;
  name: string;
  state: BroadcastState;
  target: string;
  patch: string;
  notify: number;
  at: number | null;
  clear_after: number | null;
  expect: string | null;
  parent_id: string | null;
  targeted: number;
  error_code: string | null;
  created_by_type: string | null;
  created_by_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  checked_at: number | null;
}

export interface NewBroadcast {
  id: string;
  orgId: string;
  mode: Mode;
  kind: BroadcastKind;
  name: string;
  state: 'draft' | 'scheduled';
  target: unknown;
  patch: unknown;
  notify: boolean;
  at: number | null;
  clearAfter: number | null;
  expect?: unknown;
  parentId?: string | null;
  actor: { type: string; id: string | null };
  now: number;
}

/**
 * Request writes must carry the exact checked tenant/key grant. The caller binds the actual
 * resource's org and mode separately; trusted workflow writes never use this predicate.
 */
function broadcastAuthority(
  authority: TenantPassWrite,
  now: number,
  needsPassWrite: boolean,
): { sql: string; params: SqlValue[] } {
  const allowed =
    authority.kind === 'session'
      ? authority.capability === 'messages:manage'
      : authority.scope === 'messages:write' &&
        (!needsPassWrite || authority.scopes.includes('passes:write'));
  return allowed
    ? { sql: tenantPassAuthoritySql(authority), params: tenantPassAuthorityParams(authority, now) }
    : { sql: '0', params: [] };
}

function broadcastValues(b: NewBroadcast): SqlValue[] {
  return [
    b.id,
    b.orgId,
    b.mode,
    b.kind,
    b.name,
    b.state,
    JSON.stringify(b.target),
    JSON.stringify(b.patch),
    b.notify ? 1 : 0,
    b.at,
    b.clearAfter,
    b.expect === undefined ? null : JSON.stringify(b.expect),
    b.parentId ?? null,
    b.actor.type,
    b.actor.id,
    b.now,
    null,
  ];
}

export function insertBroadcastStmt(db: D1Database, b: NewBroadcast): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, notify, at,
       clear_after, expect, parent_id, created_by_type, created_by_id, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    broadcastValues(b),
  );
}

/** Insert a user-requested draft/schedule only while its checked authority is still current. */
export function insertAuthorizedBroadcastStmt(
  db: D1Database,
  b: NewBroadcast,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, b.kind === 'change');
  return stmt(
    db,
    `INSERT OR IGNORE INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, notify, at,
       clear_after, expect, parent_id, created_by_type, created_by_id, created_at, started_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ? = ? AND ? = ? AND (${guard.sql})`,
    [...broadcastValues(b), b.orgId, authority.orgId, b.mode, authority.mode, ...guard.params],
  );
}

/** Outside the org reads as missing. API keys read their own mode, sessions either. */
export const getBroadcast = (db: D1Database, id: string, scope: ScopeArg) =>
  first<BroadcastRow>(
    db,
    'SELECT * FROM broadcasts WHERE id = ? AND (? IS NULL OR org_id = ?) AND (? IS NULL OR mode = ?)',
    [id, scopeOrg(scope), scopeOrg(scope), readMode(scope), readMode(scope)],
  );

export interface BroadcastListFilter {
  orgId: string;
  mode: Mode;
  state?: BroadcastState | undefined;
  cursor?: string | undefined;
  limit: number;
}

export async function listBroadcasts(
  db: D1Database,
  f: BroadcastListFilter,
): Promise<{ rows: BroadcastRow[]; nextCursor: string | null }> {
  const where = ['org_id = ?', 'mode = ?'];
  const params: (string | number)[] = [f.orgId, f.mode];
  if (f.state) {
    where.push('state = ?');
    params.push(f.state);
  }
  if (f.cursor) {
    where.push('id < ?');
    params.push(f.cursor);
  }
  const rows = await all<BroadcastRow>(
    db,
    `SELECT * FROM broadcasts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    [...params, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > f.limit && last ? last.id : null };
}

/** Moves a broadcast between states only if it is still in `from`. True when this caller won. */
export async function casState(
  db: D1Database,
  id: string,
  from: readonly BroadcastState[],
  to: BroadcastState,
  extra: { startedAt?: number; finishedAt?: number; errorCode?: string | null } = {},
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE broadcasts SET state = ?,
       started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at),
       error_code = COALESCE(?, error_code)
     WHERE id = ? AND state IN (${placeholders(from.length)})`,
    [to, extra.startedAt ?? null, extra.finishedAt ?? null, extra.errorCode ?? null, id, ...from],
  );
  return changes === 1;
}

/** Schedule exactly the draft and kind which were checked by the caller. */
export function scheduleBroadcastStmt(
  db: D1Database,
  id: string,
  kind: BroadcastKind,
  at: number,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, kind === 'change');
  return stmt(
    db,
    `UPDATE broadcasts SET state = 'scheduled', at = ?
     WHERE id = ? AND state = 'draft' AND kind = ? AND org_id = ? AND mode = ? AND (${guard.sql})`,
    [at, id, kind, authority.orgId, authority.mode, ...guard.params],
  );
}

/** Cancel only the authorized tenant and mode while the principal remains valid. */
export function cancelBroadcastStmt(
  db: D1Database,
  id: string,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, false);
  return stmt(
    db,
    `UPDATE broadcasts SET state = 'cancelled', finished_at = ?
     WHERE id = ? AND state IN ('draft', 'scheduled') AND org_id = ? AND mode = ? AND (${guard.sql})`,
    [now, id, authority.orgId, authority.mode, ...guard.params],
  );
}

/** Scheduled broadcasts whose time has come, oldest first. */
export const dueBroadcasts = (db: D1Database, now: number, limit: number) =>
  all<BroadcastRow>(
    db,
    `SELECT * FROM broadcasts WHERE state = 'scheduled' AND at <= ? ORDER BY at LIMIT ?`,
    [now, limit],
  );

/**
 * Broadcasts that have been sending since before `before` and not checked since: a workflow may
 * have died under them. Least recently checked first, so a few long sends never hide a dead one.
 */
export const sendingSince = (db: D1Database, before: number, limit: number) =>
  all<BroadcastRow>(
    db,
    `SELECT * FROM broadcasts WHERE state = 'sending' AND COALESCE(checked_at, started_at) < ?
     ORDER BY COALESCE(checked_at, started_at) LIMIT ?`,
    [before, limit],
  );

export const markChecked = (db: D1Database, id: string, at: number) =>
  run(db, `UPDATE broadcasts SET checked_at = ? WHERE id = ? AND state = 'sending'`, [at, id]);

export interface BroadcastEdit {
  name: string;
  kind: BroadcastKind;
  target: unknown;
  patch: unknown;
  notify: boolean;
  state: 'draft' | 'scheduled';
  at: number | null;
  clearAfter: number | null;
}

/** Replace only the previously checked kind while the exact principal remains authorized. */
export function updateBroadcastStmt(
  db: D1Database,
  id: string,
  originalKind: BroadcastKind,
  e: BroadcastEdit,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(
    authority,
    now,
    originalKind === 'change' || e.kind === 'change',
  );
  return stmt(
    db,
    `UPDATE broadcasts SET name = ?, kind = ?, target = ?, patch = ?, notify = ?, state = ?, at = ?,
       clear_after = ? WHERE id = ? AND state IN ('draft', 'scheduled') AND kind = ?
       AND org_id = ? AND mode = ? AND (${guard.sql})`,
    [
      e.name,
      e.kind,
      JSON.stringify(e.target),
      JSON.stringify(e.patch),
      e.notify ? 1 : 0,
      e.state,
      e.at,
      e.clearAfter,
      id,
      originalKind,
      authority.orgId,
      authority.mode,
      ...guard.params,
    ],
  );
}

export const setTargeted = (db: D1Database, id: string, targeted: number) =>
  run(db, 'UPDATE broadcasts SET targeted = ? WHERE id = ?', [targeted, id]);

/** The clearing follow-up of each broadcast that has one. */
export const followUpsOf = (
  db: D1Database,
  parentIds: readonly string[],
  orgId: string,
  mode: Mode,
) =>
  parentIds.length === 0
    ? Promise.resolve([] as { id: string; parent_id: string; at: number | null }[])
    : all<{ id: string; parent_id: string; at: number | null }>(
        db,
        `SELECT child.id, child.parent_id, child.at
         FROM broadcasts child JOIN broadcasts parent ON parent.id = child.parent_id
           AND parent.org_id = child.org_id AND parent.mode = child.mode
         WHERE parent.org_id = ? AND parent.mode = ?
           AND child.parent_id IN (SELECT value FROM json_each(?))`,
        [orgId, mode, JSON.stringify(parentIds)],
      );
