import { localDayStart } from './counts.ts';
import type { ScanActor } from './guard.ts';

export const GROUP_MAX = 10;

export interface BundleRead {
  id: string;
  name: string;
  passIds: string[];
}

/** The newest bundle of this org and mode that holds the pass, with its members in order. */
export async function bundleOf(
  db: D1Database,
  orgId: string,
  mode: string,
  passId: string,
): Promise<BundleRead | null> {
  const head = await db
    .prepare(
      `SELECT b.id, b.name FROM bundle_passes bp JOIN bundles b ON b.id = bp.bundle_id
       WHERE bp.pass_id = ? AND b.org_id = ? AND b.mode = ? ORDER BY b.id DESC LIMIT 1`,
    )
    .bind(passId, orgId, mode)
    .first<{ id: string; name: string }>();
  if (!head) return null;
  const rows = await db
    .prepare(`SELECT pass_id FROM bundle_passes WHERE bundle_id = ? ORDER BY position LIMIT ?`)
    .bind(head.id, GROUP_MAX)
    .all<{ pass_id: string }>();
  return { ...head, passIds: rows.results.map((r) => r.pass_id) };
}

/** Members with a live check-in for the scanner's event, or today at a scanner with none. */
export async function checkedInCount(
  db: D1Database,
  actor: ScanActor,
  bundleId: string,
  now: number,
): Promise<number> {
  const scope = actor.event
    ? { sql: 's.event_id = ?', arg: actor.event.id }
    : { sql: 's.at >= ?', arg: localDayStart(now, actor.timeZone) };
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT s.pass_id) AS n FROM scans s
       WHERE s.org_id = ? AND s.mode = ? AND s.action_kind = 'check_in' AND s.outcome = 'ok'
         AND s.undone_by IS NULL AND COALESCE(s.direction, 'in') = 'in' AND ${scope.sql}
         AND s.pass_id IN (SELECT pass_id FROM bundle_passes WHERE bundle_id = ?)`,
    )
    .bind(actor.orgId, actor.mode, scope.arg, bundleId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function scanPassId(db: D1Database, orgId: string, scanId: string) {
  const row = await db
    .prepare('SELECT pass_id FROM scans WHERE id = ? AND org_id = ?')
    .bind(scanId, orgId)
    .first<{ pass_id: string | null }>();
  return row?.pass_id ?? null;
}

/** Records the scans one group request made, so one undo reverses them all. */
export async function recordGroup(
  db: D1Database,
  orgId: string,
  groupScanId: string,
  scanIds: readonly string[],
) {
  await db.batch(
    scanIds.map((id) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO scan_group_members (group_scan_id, scan_id, org_id) VALUES (?, ?, ?)',
        )
        .bind(groupScanId, id, orgId),
    ),
  );
}

export async function groupMembers(db: D1Database, orgId: string, groupScanId: string) {
  const rows = await db
    .prepare(
      'SELECT scan_id FROM scan_group_members WHERE group_scan_id = ? AND org_id = ? ORDER BY scan_id',
    )
    .bind(groupScanId, orgId)
    .all<{ scan_id: string }>();
  return rows.results.map((r) => r.scan_id);
}

/** Passes whose latest live check-in in the scanner's scope (event, or today) is an entry. */
export async function livePassIds(
  db: D1Database,
  actor: ScanActor,
  passIds: readonly string[],
  now: number,
): Promise<Set<string>> {
  const scope = actor.event
    ? { sql: 'event_id = ?', arg: actor.event.id }
    : { sql: 'at >= ?', arg: localDayStart(now, actor.timeZone) };
  const rows = await db
    .prepare(
      `SELECT pass_id, direction FROM scans
       WHERE org_id = ? AND mode = ? AND action_kind = 'check_in' AND outcome = 'ok'
         AND undone_by IS NULL AND ${scope.sql} AND pass_id IN (${passIds.map(() => '?').join(',')})
       ORDER BY at DESC, id DESC`,
    )
    .bind(actor.orgId, actor.mode, scope.arg, ...passIds)
    .all<{ pass_id: string; direction: string | null }>();
  const latest = new Map<string, string | null>();
  for (const r of rows.results) if (!latest.has(r.pass_id)) latest.set(r.pass_id, r.direction);
  return new Set([...latest].filter(([, d]) => (d ?? 'in') === 'in').map(([id]) => id));
}
