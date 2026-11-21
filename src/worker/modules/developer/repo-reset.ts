import { all, first, run } from '../../platform/db.ts';
import { orgPasses } from '../org-lifecycle/repo-purge.ts';

/**
 * True only for the sandbox whose reset this call claimed: a developer org, active, its sandbox record open and
 * owned by `?2`, the track restarted at exactly `?3` (the claim's stamp, which a later reset moves on), and no
 * legal hold on the org. Every delete below repeats it, so a closed, foreign, non-sandbox or held org loses
 * nothing, and a delete that runs late (after a close or a newer reset) deletes nothing.
 */
export const RESETTING = `EXISTS (SELECT 1 FROM orgs o JOIN developer_sandboxes d ON d.org_id = o.id
  WHERE o.id = ?1 AND o.kind = 'developer' AND o.status = 'active'
    AND d.user_id = ?2 AND d.closed_at IS NULL AND d.track_started_at = ?3
    AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))`;

const SLICE = 500;
const MAX_SLICES = 20;

export interface SandboxRowsDeleted {
  request_log: number;
  idempotent_requests: number;
  idempotency_keys: number;
}

/** One table in slices of `SLICE` rowids, so a reset never holds the database long. `delete` runs one slice. */
async function sliced(slice: () => Promise<{ changes: number }>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_SLICES; i++) {
    const { changes } = await slice();
    total += changes;
    if (changes < SLICE) break;
  }
  return total;
}

/**
 * The rows a reset removes besides passes, each only in the sandbox's own org and only while the claim stands
 * (`RESETTING`). Test data only: the org, template, capture endpoint, keys, membership and the funnel stay.
 * The hourly capture counters stay too, so a reset gives back no abuse budget.
 */
export async function deleteSandboxRows(
  db: D1Database,
  orgId: string,
  userId: string,
  stamp: number,
): Promise<SandboxRowsDeleted> {
  const p = [orgId, userId, stamp];
  return {
    request_log: await sliced(() =>
      run(
        db,
        `DELETE FROM request_log WHERE rowid IN (SELECT rowid FROM request_log WHERE org_id = ?1 AND ${RESETTING} LIMIT ${SLICE})`,
        p,
      ),
    ),
    // Short-lived and few: one statement each.
    idempotent_requests: (
      await run(db, `DELETE FROM idempotent_requests WHERE org_id = ?1 AND ${RESETTING}`, p)
    ).changes,
    idempotency_keys: (
      await run(db, `DELETE FROM idempotency_keys WHERE org_id = ?1 AND ${RESETTING}`, p)
    ).changes,
  };
}

/** The sandbox's test passes after `after`, by id: soft-deleted ones too. The org is checked by the caller's claim. */
export const sandboxPasses = (db: D1Database, orgId: string, after: string, limit: number) =>
  orgPasses(db, orgId, after, limit, false);

/** True while the claim still stands: the org is this sandbox's and its track restarted at `stamp`. */
export async function claimStands(
  db: D1Database,
  orgId: string,
  userId: string,
  stamp: number,
): Promise<boolean> {
  const rows = await all<{ ok: number }>(db, `SELECT 1 AS ok WHERE ${RESETTING}`, [
    orgId,
    userId,
    stamp,
  ]);
  return rows.length > 0;
}

/** Resets claimed in the last day: the audit rows each claim writes in its own batch. */
export const resetsClaimedSince = async (
  db: D1Database,
  orgId: string,
  action: string,
  since: number,
) =>
  (
    await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = ? AND at > ?',
      [orgId, action, since],
    )
  )?.n ?? 0;

/** When the track last started: the stamp a restart must pass. */
export const trackStartedAt = async (db: D1Database, orgId: string) =>
  (
    await first<{ t: number }>(
      db,
      'SELECT COALESCE(track_started_at, created_at) AS t FROM developer_sandboxes WHERE org_id = ?',
      [orgId],
    )
  )?.t ?? 0;

/** The person's own sandbox keys not yet revoked. */
export const openSandboxKeys = (db: D1Database, orgId: string, userId: string, name: string) =>
  all<{ id: string }>(
    db,
    "SELECT id FROM api_keys WHERE org_id = ? AND created_by = ? AND name = ? AND kind = 'personal' AND revoked_at IS NULL",
    [orgId, userId, name],
  );

/** A closed org's window: when it purges, and whether the purge has started. */
export const reopenWindow = (db: D1Database, orgId: string) =>
  first<{ purge_after: number | null; purge_started_at: number | null }>(
    db,
    'SELECT purge_after, purge_started_at FROM orgs WHERE id = ?',
    [orgId],
  );

/** A legal hold stands on the org: a reset refuses, as a delete of its data would. */
export const orgHeld = async (db: D1Database, orgId: string): Promise<boolean> =>
  (await first(
    db,
    'SELECT 1 AS x FROM retention_holds WHERE org_id = ? AND released_at IS NULL LIMIT 1',
    [orgId],
  )) !== null;
