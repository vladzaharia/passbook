import { all } from '../../platform/db.ts';

/**
 * Why a pass cannot move faithfully and stays on its identity, or NULL: the one place a reason is decided, for
 * the plan and for the dry run. A connection owns the serial it syncs; assets are bound to the pass.
 */
const KEPT = `CASE WHEN p.connection_id IS NOT NULL THEN 'connection'
  WHEN EXISTS (SELECT 1 FROM pass_assets a WHERE a.pass_id = p.id) THEN 'assets' END`;

const PENDING_TRANSFER = `EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')`;

const LIVE_ACTIVE = `p.org_id = ? AND p.identity_id = ? AND p.mode = 'live' AND p.status = 'active'
  AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.test_data_quarantined = 0
  AND NOT EXISTS (SELECT 1 FROM pass_moves m WHERE m.old_pass_id = p.id)`;

export interface Candidate {
  id: string;
  /** Why the pass stays where it is; null when it moves. */
  reason: string | null;
}

/** Active Live passes on `identityId` with no move yet, after `after`, in id order. */
export function candidates(
  db: D1Database,
  q: { orgId: string; identityId: string; after: string; limit: number },
): Promise<Candidate[]> {
  return all<Candidate>(
    db,
    `SELECT p.id, ${KEPT} AS reason FROM passes p
     WHERE ${LIVE_ACTIVE} AND p.id > ? AND NOT ${PENDING_TRANSFER}
     ORDER BY p.id LIMIT ?`,
    [q.orgId, q.identityId, q.after, q.limit],
  );
}

export interface MoveCounts {
  /** Passes that would move. */
  passes: number;
  /** Of those, the ones with a device registration. */
  registered: number;
  holders: number;
  /** Passes that stay on the old identity, by reason. A pending transfer counts as `transfer`. */
  kept: Record<string, number>;
}

/** The dry run: what a move would touch, and what stays. */
export async function countCandidates(
  db: D1Database,
  orgId: string,
  identityId: string,
): Promise<MoveCounts> {
  const rows = await all<{ reason: string | null; n: number; registered: number; holders: number }>(
    db,
    `SELECT CASE WHEN ${PENDING_TRANSFER} THEN 'transfer' ELSE ${KEPT} END AS reason, count(*) AS n,
       coalesce(sum(EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = p.id)), 0) AS registered,
       count(DISTINCT p.holder_email) AS holders
     FROM passes p WHERE ${LIVE_ACTIVE} GROUP BY 1`,
    [orgId, identityId],
  );
  const counts: MoveCounts = { passes: 0, registered: 0, holders: 0, kept: {} };
  for (const r of rows) {
    if (r.reason === null)
      Object.assign(counts, { passes: r.n, registered: r.registered, holders: r.holders });
    else counts.kept[r.reason] = r.n;
  }
  return counts;
}
