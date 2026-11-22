import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanTarget } from '../../../shared/contracts/scan.ts';
import { all, first, stmt } from '../../platform/db.ts';
import { ruleWindowWhere } from '../message-rules/repo-window.ts';
import type { RuleWindow } from '../message-rules/windows.ts';
import { notifiedWhere } from '../passes/repo-budget.ts';
import { type PassListFilter, passFilterSql } from '../passes/repo-list.ts';
import { mapPass, PASS_SELECT, type Pass, type PassDbRow } from '../passes/repo-map.ts';

type TargetFilter = PassListFilter & {
  orgId: string;
  mode: Mode;
  scan?: ScanTarget;
  /** An automatic message's due window, and the rule whose fires it skips. */
  window?: RuleWindow;
  ruleId?: string;
  /** The run itself: its own fire rows do not exclude a pass. */
  broadcastId?: string;
  /** Only these passes: a test send (one) or a change run's chosen passes (up to 5,000). */
  passIds?: string[];
  /** Only the passes snapshotted for this change run (`broadcast_targets`). */
  snapshot?: string;
  /** Only passes this broadcast updated or found already showing its text: a follow-up that clears its message. */
  sentBy?: string;
};

/** Active, unremoved passes whose current version has not expired. SQLite reads ISO offsets. */
function targetWhere(filter: TargetFilter, now: number) {
  const { orgId, mode, ...criteria } = filter;
  const { where, params } = passFilterSql({ ...criteria, excludeRemoved: true, status: 'active' });
  where.push('org_id = ?', 'mode = ?');
  params.push(orgId, mode);
  if (filter.scan) {
    if ('eventId' in filter.scan) {
      where.push(`${filter.scan.checkedIn ? '' : 'NOT '}EXISTS (
        SELECT 1 FROM scan_gates g WHERE g.pass_id = passes.id
          AND g.org_id = passes.org_id AND g.mode = passes.mode
          AND g.scope = ? AND g.kind = 'check_in' AND g.state IN ('in', 'out'))`);
      params.push(`event:${filter.scan.eventId}`);
    } else {
      where.push(`NOT EXISTS (
        SELECT 1 FROM scans s WHERE s.pass_id = passes.id
          AND s.org_id = passes.org_id AND s.mode = passes.mode
          AND s.state = 'done' AND s.at >= ?)`);
      params.push(now - filter.scan.noScanDays * 86_400_000);
    }
  }
  if (filter.window) {
    const w = ruleWindowWhere(filter.window, filter.ruleId ?? '', filter.broadcastId);
    where.push(w.sql);
    params.push(...(w.params as (string | number)[]));
  }
  if (filter.passIds) {
    // json_each keeps the statement under D1's 100 bound parameters.
    where.push('passes.id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(filter.passIds));
  }
  if (filter.snapshot) {
    where.push(`EXISTS (SELECT 1 FROM broadcast_targets bt WHERE bt.broadcast_id = ?
      AND bt.pass_id = passes.id)`);
    params.push(filter.snapshot);
  }
  if (filter.sentBy) {
    where.push(`EXISTS (SELECT 1 FROM broadcast_items bi WHERE bi.broadcast_id = ?
      AND bi.pass_id = passes.id AND bi.outcome IN ('updated', 'unchanged'))`);
    params.push(filter.sentBy);
  }
  where.push(`NOT COALESCE((SELECT unixepoch(json_extract(v.pass_json, '$.expirationDate')) * 1000 <= ?
      FROM pass_versions v WHERE v.pass_id = passes.id ORDER BY v.version DESC LIMIT 1), 0)`);
  return { where, params: [...params, now] };
}

/** Chosen passes are read this many at a time. */
const SLICE = 500;

function slicesOf(filter: TargetFilter): TargetFilter[] {
  const ids = filter.passIds;
  if (!ids || ids.length <= SLICE) return [filter];
  const out: TargetFilter[] = [];
  for (let i = 0; i < ids.length; i += SLICE)
    out.push({ ...filter, passIds: ids.slice(i, i + SLICE) });
  return out;
}

/** One page of target pass ids, newest first, after `cursor`. */
export async function targetPage(
  db: D1Database,
  filter: TargetFilter,
  now: number,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  if (filter.passIds) {
    // Chosen passes page through the list itself; the cursor is the last candidate, so passes the
    // filters leave out never stall it.
    const candidates = [...filter.passIds]
      .sort()
      .reverse()
      .filter((id) => !filter.cursor || id < filter.cursor)
      .slice(0, filter.limit);
    if (candidates.length === 0) return { ids: [], nextCursor: null };
    const { where, params } = targetWhere({ ...filter, passIds: candidates }, now);
    const rows = await all<{ id: string }>(
      db,
      `SELECT id FROM passes WHERE ${where.join(' AND ')} ORDER BY id DESC`,
      params,
    );
    return {
      ids: rows.map((r) => r.id),
      nextCursor: candidates.length === filter.limit ? (candidates.at(-1) ?? null) : null,
    };
  }
  const { where, params } = targetWhere(filter, now);
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

/** How many live, unexpired passes a target matches, how many sit on a device, how many are at the limit. */
export async function countTarget(
  db: D1Database,
  filter: TargetFilter,
  now: number,
  since: number,
  limit: number,
): Promise<TargetCounts> {
  const total: TargetCounts = { targeted: 0, onDevice: 0, overBudget: 0 };
  for (const slice of slicesOf(filter)) {
    const { where, params } = targetWhere(slice, now);
    const row = await first<TargetCounts>(
      db,
      `SELECT COUNT(*) AS targeted,
       COALESCE(SUM(EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = passes.id)), 0) AS onDevice,
       COALESCE(SUM(EXISTS (SELECT 1 FROM pass_events e
                           WHERE e.pass_id = passes.id AND e.org_id = passes.org_id
                             AND e.mode = passes.mode AND ${notifiedWhere}
                           GROUP BY e.pass_id HAVING COUNT(*) >= ?)), 0) AS overBudget
     FROM passes WHERE ${where.join(' AND ')}`,
      [since, limit, ...params],
    );
    total.targeted += row?.targeted ?? 0;
    total.onDevice += row?.onDevice ?? 0;
    total.overBudget += row?.overBudget ?? 0;
  }
  return total;
}

/** The count as a statement, so many windows run in one batch. */
export function countTargetedStmt(db: D1Database, filter: TargetFilter, now: number) {
  const { where, params } = targetWhere(filter, now);
  return stmt(db, `SELECT COUNT(*) AS n FROM passes WHERE ${where.join(' AND ')}`, params);
}

export async function countTargeted(
  db: D1Database,
  filter: TargetFilter,
  now: number,
): Promise<number> {
  let n = 0;
  for (const slice of slicesOf(filter)) {
    const { where, params } = targetWhere(slice, now);
    const row = await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM passes WHERE ${where.join(' AND ')}`,
      params,
    );
    n += row?.n ?? 0;
  }
  return n;
}

/** Up to `limit` of the newest target passes with their inputs, for a preview's samples. */
export async function targetRows(
  db: D1Database,
  filter: TargetFilter,
  now: number,
  limit: number,
): Promise<Pass[]> {
  const rows: Pass[] = [];
  for (const slice of slicesOf(filter)) {
    if (rows.length >= limit) break;
    const { where, params } = targetWhere(slice, now);
    const page = await all<PassDbRow>(
      db,
      `${PASS_SELECT} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      [...params, limit - rows.length],
    );
    rows.push(...page.map(mapPass));
  }
  return rows;
}

/** Of these passes, the ones on a device and the ones at their daily push limit. */
export async function sampleBudgetState(
  db: D1Database,
  ids: readonly string[],
  orgId: string,
  mode: Mode,
  since: number,
  limit: number,
): Promise<{ onDevice: Set<string>; over: Set<string> }> {
  const onDevice = new Set<string>();
  const over = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const json = JSON.stringify(ids.slice(i, i + 500));
    const devices = await all<{ pass_id: string }>(
      db,
      'SELECT DISTINCT pass_id FROM registrations WHERE pass_id IN (SELECT value FROM json_each(?))',
      [json],
    );
    for (const r of devices) onDevice.add(r.pass_id);
    const full = await all<{ pass_id: string }>(
      db,
      `SELECT e.pass_id FROM pass_events e WHERE e.org_id = ? AND e.mode = ? AND ${notifiedWhere}
         AND e.pass_id IN (SELECT value FROM json_each(?)) GROUP BY e.pass_id HAVING COUNT(*) >= ?`,
      [orgId, mode, since, json, limit],
    );
    for (const r of full) over.add(r.pass_id);
  }
  return { onDevice, over };
}
