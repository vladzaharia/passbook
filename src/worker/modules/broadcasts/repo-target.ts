import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanTarget } from '../../../shared/contracts/scan.ts';
import { all, first } from '../../platform/db.ts';
import { notifiedWhere } from '../passes/repo-budget.ts';
import { type PassListFilter, passFilterSql } from '../passes/repo-list.ts';

type TargetFilter = PassListFilter & { orgId: string; mode: Mode; scan?: ScanTarget };

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
  where.push(`NOT COALESCE((SELECT unixepoch(json_extract(v.pass_json, '$.expirationDate')) * 1000 <= ?
      FROM pass_versions v WHERE v.pass_id = passes.id ORDER BY v.version DESC LIMIT 1), 0)`);
  return { where, params: [...params, now] };
}

/** One page of target pass ids, newest first, after `cursor`. */
export async function targetPage(
  db: D1Database,
  filter: TargetFilter,
  now: number,
): Promise<{ ids: string[]; nextCursor: string | null }> {
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
  const { where, params } = targetWhere(filter, now);
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
  return row ?? { targeted: 0, onDevice: 0, overBudget: 0 };
}

export async function countTargeted(
  db: D1Database,
  filter: TargetFilter,
  now: number,
): Promise<number> {
  const { where, params } = targetWhere(filter, now);
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes WHERE ${where.join(' AND ')}`,
    params,
  );
  return row?.n ?? 0;
}
