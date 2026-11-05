import type { BroadcastKind, BroadcastState } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, batch, first, placeholders, run, stmt } from '../../platform/db.ts';

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

/** Replaces a draft or a scheduled broadcast that has not started. False when it already moved on. */
export async function updateBroadcast(
  db: D1Database,
  id: string,
  e: BroadcastEdit,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE broadcasts SET name = ?, kind = ?, target = ?, patch = ?, notify = ?, state = ?, at = ?,
       clear_after = ? WHERE id = ? AND state IN ('draft', 'scheduled')`,
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
    ],
  );
  return changes === 1;
}

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

/** The clearing follow-up of each broadcast that has one. */
export const followUpsOf = (db: D1Database, parentIds: readonly string[]) =>
  parentIds.length === 0
    ? Promise.resolve([] as { id: string; parent_id: string; at: number | null }[])
    : all<{ id: string; parent_id: string; at: number | null }>(
        db,
        `SELECT id, parent_id, at FROM broadcasts WHERE parent_id IN (${placeholders(parentIds.length)})`,
        [...parentIds],
      );
