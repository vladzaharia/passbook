import type { Mode } from '../../../shared/contracts/common.ts';
import { all, batch, first, placeholders, run, stmt } from '../../platform/db.ts';
import { notifiedWhere } from '../passes/repo-budget.ts';
import { type PassListFilter, passFilterSql } from '../passes/repo-list.ts';

export type BroadcastKind = 'message' | 'change';
export type BroadcastState =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'cancelled';

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

export function insertBroadcastStmt(db: D1Database, b: NewBroadcast): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, notify, at,
       clear_after, expect, parent_id, created_by_type, created_by_id, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
  );
}

/** `orgScope` null = platform-wide. A broadcast outside the scope reads as missing. Either mode. */
export const getBroadcast = (db: D1Database, id: string, orgScope: string | null) =>
  first<BroadcastRow>(db, 'SELECT * FROM broadcasts WHERE id = ? AND (? IS NULL OR org_id = ?)', [
    id,
    orgScope,
    orgScope,
  ]);

export interface BroadcastListFilter {
  orgScope: string | null;
  orgId?: string | undefined;
  mode: Mode;
  state?: BroadcastState | undefined;
  cursor?: string | undefined;
  limit: number;
}

export async function listBroadcasts(
  db: D1Database,
  f: BroadcastListFilter,
): Promise<{ rows: BroadcastRow[]; nextCursor: string | null }> {
  const where = ['mode = ?'];
  const params: (string | number)[] = [f.mode];
  const orgId = f.orgScope ?? f.orgId;
  if (orgId) {
    where.push('org_id = ?');
    params.push(orgId);
  }
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

/** A draft takes its send time and waits for the minute cron (or an immediate launch). */
export async function casSchedule(db: D1Database, id: string, at: number): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE broadcasts SET state = 'scheduled', at = ? WHERE id = ? AND state = 'draft'`,
    [at, id],
  );
  return changes === 1;
}

/** Scheduled broadcasts whose time has come, oldest first. */
export const dueBroadcasts = (db: D1Database, now: number, limit: number) =>
  all<BroadcastRow>(
    db,
    `SELECT * FROM broadcasts WHERE state = 'scheduled' AND at <= ? ORDER BY at LIMIT ?`,
    [now, limit],
  );

export const setTargeted = (db: D1Database, id: string, targeted: number) =>
  run(db, 'UPDATE broadcasts SET targeted = ? WHERE id = ?', [targeted, id]);

export type Outcome = 'updated' | 'unchanged' | 'failed';

export interface ItemRow {
  passId: string;
  outcome: Outcome;
  silent: boolean;
}

/** Idempotent: a pass that already has an outcome keeps it. */
export async function insertItems(
  db: D1Database,
  broadcastId: string,
  items: readonly ItemRow[],
): Promise<void> {
  await batch(
    db,
    items.map((i) =>
      stmt(
        db,
        `INSERT OR IGNORE INTO broadcast_items (broadcast_id, pass_id, outcome, silent) VALUES (?, ?, ?, ?)`,
        [broadcastId, i.passId, i.outcome, i.silent ? 1 : 0],
      ),
    ),
  );
}

export async function handledPassIds(
  db: D1Database,
  broadcastId: string,
  passIds: readonly string[],
): Promise<Set<string>> {
  if (passIds.length === 0) return new Set();
  const rows = await all<{ pass_id: string }>(
    db,
    `SELECT pass_id FROM broadcast_items WHERE broadcast_id = ? AND pass_id IN (${placeholders(passIds.length)})`,
    [broadcastId, ...passIds],
  );
  return new Set(rows.map((r) => r.pass_id));
}

export interface CountRow {
  broadcast_id: string;
  outcome: Outcome;
  silent: number;
  n: number;
}

export const countItems = (db: D1Database, broadcastIds: readonly string[]) =>
  broadcastIds.length === 0
    ? Promise.resolve([] as CountRow[])
    : all<CountRow>(
        db,
        `SELECT broadcast_id, outcome, silent, COUNT(*) AS n FROM broadcast_items
         WHERE broadcast_id IN (${placeholders(broadcastIds.length)}) GROUP BY broadcast_id, outcome, silent`,
        [...broadcastIds],
      );

/** One page of target pass ids, newest first, after `cursor`. */
export async function targetPage(
  db: D1Database,
  filter: PassListFilter,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  const { where, params } = passFilterSql({ ...filter, excludeRemoved: true, status: 'active' });
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    [...params, filter.limit],
  );
  const ids = rows.map((r) => r.id);
  return { ids, nextCursor: ids.length === filter.limit ? (ids.at(-1) ?? null) : null };
}

export interface TargetCounts {
  targeted: number;
  onDevice: number;
  overBudget: number;
}

/** How many active passes a target matches, how many sit on a device, how many are at the limit. */
export async function countTarget(
  db: D1Database,
  filter: PassListFilter,
  since: number,
  limit: number,
): Promise<TargetCounts> {
  const { where, params } = passFilterSql({ ...filter, excludeRemoved: true, status: 'active' });
  const row = await first<TargetCounts>(
    db,
    `SELECT COUNT(*) AS targeted,
       COALESCE(SUM(EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = passes.id)), 0) AS onDevice,
       COALESCE(SUM(id IN (SELECT pass_id FROM pass_events WHERE org_id = ? AND ${notifiedWhere}
                           GROUP BY pass_id HAVING COUNT(*) >= ?)), 0) AS overBudget
     FROM passes WHERE ${where.join(' AND ')}`,
    [filter.orgId ?? '', since, limit, ...params],
  );
  return row ?? { targeted: 0, onDevice: 0, overBudget: 0 };
}

export async function countTargeted(db: D1Database, filter: PassListFilter): Promise<number> {
  const { where, params } = passFilterSql({ ...filter, excludeRemoved: true, status: 'active' });
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes WHERE ${where.join(' AND ')}`,
    params,
  );
  return row?.n ?? 0;
}
