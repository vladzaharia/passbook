import { all, first, run } from '../../platform/db.ts';
import { orgPasses } from '../org-lifecycle/repo-purge.ts';
import { UNRESERVED_BUNDLE } from '../sandbox/repo.ts';

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

/**
 * What a reset deletes besides passes and captured webhooks, each only in the sandbox's own org, in Test, and
 * while the claim stands. A request or an email still in flight is left (a settled idempotency record, a
 * forward that is not sending). Bundles go with their capability links; broadcasts and rules are Test only.
 */
export const RESET_TABLES = {
  request_log: { where: 'at <= ?3', rowid: true },
  idempotent_requests: { where: 'created_at <= ?3 AND status IS NOT NULL', rowid: false },
  idempotency_keys: { where: 'created_at <= ?3 AND resource_id IS NOT NULL', rowid: false },
  captured_emails: {
    where: `created_at <= ?3 AND NOT EXISTS (SELECT 1 FROM sandbox_forwards f WHERE f.capture_id = captured_emails.id
      AND f.state IN ('sending', 'unknown'))`,
    rowid: true,
  },
  bundles: { where: `created_at <= ?3 AND mode = 'test' AND ${UNRESERVED_BUNDLE}`, rowid: true },
  pass_imports: {
    where: "created_at <= ?3 AND mode = 'test' AND state <> 'committing'",
    rowid: true,
  },
  broadcasts: {
    where: "created_at <= ?3 AND mode = 'test' AND state <> 'sending'",
    rowid: true,
  },
  message_rules: { where: "created_at <= ?3 AND mode = 'test'", rowid: true },
} as const;

export type ResetTable = keyof typeof RESET_TABLES;

/**
 * One slice of one table: at most `SLICE` rows, with `RESETTING` repeated in the statement. A table with no
 * rowid is a single statement (its rows are few and short-lived). The rows removed; `SLICE` means "ask again".
 */
export async function deleteSlice(
  db: D1Database,
  table: ResetTable,
  orgId: string,
  userId: string,
  stamp: number,
): Promise<number> {
  const spec = RESET_TABLES[table];
  const p = [orgId, userId, stamp];
  if (!spec.rowid)
    return (
      await run(db, `DELETE FROM ${table} WHERE org_id = ?1 AND ${spec.where} AND ${RESETTING}`, p)
    ).changes;
  return (
    await run(
      db,
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}
         WHERE org_id = ?1 AND ${spec.where} AND ${RESETTING} LIMIT ${SLICE})`,
      p,
    )
  ).changes;
}

export const SLICE_ROWS = SLICE;

/**
 * The uploaded files of the Test imports a reset is about to delete: the same condition as their rows, under the
 * claim. The files go after their rows.
 */
export const importObjectKeys = async (
  db: D1Database,
  orgId: string,
  userId: string,
  stamp: number,
): Promise<string[]> =>
  (
    await all<{ object_key: string }>(
      db,
      `SELECT object_key FROM pass_imports WHERE org_id = ?1 AND object_key IS NOT NULL
         AND ${RESET_TABLES.pass_imports.where} AND ${RESETTING}`,
      [orgId, userId, stamp],
    )
  ).map((r) => r.object_key);

/** `track_started_at` as stored: null until the first reset. */
export const trackStartRaw = async (db: D1Database, orgId: string): Promise<number | null> =>
  (
    await first<{ t: number | null }>(
      db,
      'SELECT track_started_at AS t FROM developer_sandboxes WHERE org_id = ?',
      [orgId],
    )
  )?.t ?? null;

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

/** Why the sandbox closed: `user`, `idle` or `admin`. */
export const closeReasonOf = async (db: D1Database, orgId: string): Promise<string | null> =>
  (
    await first<{ close_reason: string | null }>(
      db,
      'SELECT close_reason FROM developer_sandboxes WHERE org_id = ?',
      [orgId],
    )
  )?.close_reason ?? null;
