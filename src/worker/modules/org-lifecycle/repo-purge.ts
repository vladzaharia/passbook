import { all, batch, first, stmt } from '../../platform/db.ts';
import { mapPass, type Pass } from '../passes/repo-map.ts';
import type { PurgeStep } from './repo-plan.ts';

/**
 * True while this org is closed, in purge, voided for at least the grace period (`?2` is now minus the grace)
 * and under no active hold: repeated by every delete below.
 */
const PURGING = `EXISTS (SELECT 1 FROM orgs o WHERE o.id = ?1 AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL
  AND o.purge_voided_at IS NOT NULL AND o.purge_voided_at <= ?2
  AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))`;

const SLICE = 1000;
const MAX_SLICES = 50;
const IDENT = /^[a-z_]+$/;

function deleteSql(step: PurgeStep): string {
  if (!IDENT.test(step.table)) throw new Error('Purge step names a bad table.');
  const guard = `(${step.where}) AND ${PURGING}`;
  return step.slices
    ? `DELETE FROM ${step.table} WHERE rowid IN (SELECT rowid FROM ${step.table} WHERE ${guard} LIMIT ${SLICE})`
    : `DELETE FROM ${step.table} WHERE ${guard}`;
}

/** Rows one step removed, up to 50 slices; the next run takes the rest. */
export async function deleteStep(
  db: D1Database,
  step: PurgeStep,
  orgId: string,
  cutoff: number,
): Promise<number> {
  const sql = deleteSql(step);
  let total = 0;
  for (let i = 0; i < (step.slices ? MAX_SLICES : 1); i++) {
    const { meta } = await stmt(db, sql, [orgId, cutoff]).run();
    const changes = meta.changes ?? 0;
    total += changes;
    if (changes < SLICE) break;
  }
  return total;
}

/** Tables that reference each other: one batch, foreign keys checked when it commits. */
export async function deleteGroup(
  db: D1Database,
  steps: readonly PurgeStep[],
  orgId: string,
  cutoff: number,
): Promise<number> {
  const results = await batch(db, [
    stmt(db, 'PRAGMA defer_foreign_keys = on'),
    ...steps.map((s) => stmt(db, deleteSql(s), [orgId, cutoff])),
  ]);
  return results.slice(1).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Rows a step would still delete; the `PURGING` clause is left out so a hold shows as rows left. */
export async function remaining(db: D1Database, step: PurgeStep, orgId: string): Promise<number> {
  if (!IDENT.test(step.table)) throw new Error('Purge step names a bad table.');
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM ${step.table} WHERE ${step.where}`,
    [orgId],
  );
  return row?.n ?? 0;
}

/** Soft-deleted or not: every pass of the org after `after`, by id. */
export async function orgPasses(
  db: D1Database,
  orgId: string,
  after: string,
  limit: number,
  onlyLive: boolean,
): Promise<Pass[]> {
  const rows = await all<Parameters<typeof mapPass>[0]>(
    db,
    `SELECT * FROM passes WHERE org_id = ? AND id > ? ${onlyLive ? 'AND deleted_at IS NULL' : ''} ORDER BY id LIMIT ?`,
    [orgId, after, limit],
  );
  return rows.map(mapPass);
}

/** The staged template uploads of the org: their files are in R2 under the upload id, not the org id. */
export const uploadIds = async (db: D1Database, orgId: string): Promise<string[]> =>
  (
    await all<{ upload_id: string }>(
      db,
      'SELECT upload_id FROM template_imports WHERE org_id = ?',
      [orgId],
    )
  ).map((r) => r.upload_id);
