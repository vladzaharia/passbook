import { WEBHOOK_CAPTURE_LIMITS } from '../../../shared/contracts/webhook-captures.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all, stmt } from '../../platform/db.ts';
import type { Scope } from '../retention/repo-sweep.ts';

/** Rows one chunk deletes, with its receipt. */
export const CHUNK = 1000;

/** `feed` also takes its deliveries and attempts with it (cascade); the others are rows of one table. */
export type PurgeKind = 'feed' | 'delivered' | 'attempts' | 'testAttempts';

const TABLE: Record<PurgeKind, string> = {
  feed: 'event_feed',
  delivered: 'webhook_deliveries',
  attempts: 'webhook_attempts',
  testAttempts: 'webhook_attempts',
};

const COND: Record<PurgeKind, string> = {
  feed: 'event_feed.at < ?',
  delivered: "webhook_deliveries.state = 'delivered' AND webhook_deliveries.finished_at < ?",
  attempts: 'webhook_attempts.at < ?',
  testAttempts: 'webhook_attempts.event_seq IS NULL AND webhook_attempts.at < ?',
};

/** An org-wide hold, or a hold on the event's pass, keeps the row (a test send has no pass: org holds only). */
const heldSql = (table: string) => {
  const pass =
    table === 'event_feed'
      ? 'event_feed.pass_id'
      : `(SELECT f.pass_id FROM event_feed f WHERE f.seq = ${table}.event_seq)`;
  return `EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = ${table}.org_id
     AND (h.pass_id IS NULL OR h.pass_id = ${pass}))`;
};

/** The platform pass skips the listed orgs; an org pass takes one. */
function scopeSql(table: string, scope: Scope): { sql: string; params: string[] } {
  return scope.kind === 'org'
    ? { sql: `${table}.org_id = ?`, params: [scope.orgId] }
    : {
        sql: `${table}.org_id NOT IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(scope.exclude)],
      };
}

/** What a row must satisfy to go, at select and at delete: age, scope and no hold. */
function eligible(kind: PurgeKind, scope: Scope, cutoff: number) {
  const table = TABLE[kind];
  const sc = scopeSql(table, scope);
  return {
    table,
    sql: `${COND[kind]} AND ${sc.sql} AND NOT ${heldSql(table)}`,
    params: [cutoff, ...sc.params],
  };
}

const IN_ROWS = (table: string) => `${table}.rowid IN (SELECT value FROM json_each(?))`;

/** The next rows past the cutoff in the scope, never a held one. */
export async function selectChunk(
  db: D1Database,
  kind: PurgeKind,
  scope: Scope,
  cutoff: number,
): Promise<number[]> {
  const e = eligible(kind, scope, cutoff);
  const rows = await all<{ id: number }>(
    db,
    `SELECT ${e.table}.rowid AS id FROM ${e.table} WHERE ${e.sql} LIMIT ${CHUNK}`,
    e.params,
  );
  return rows.map((r) => r.id);
}

/** The receipt lands only while exactly `ids.length` of the chosen rows are still eligible. */
export function receiptGate(
  kind: PurgeKind,
  scope: Scope,
  cutoff: number,
  ids: readonly number[],
): { sql: string; params: (string | number)[] } {
  const e = eligible(kind, scope, cutoff);
  return {
    sql: `(SELECT count(*) FROM ${e.table} WHERE ${IN_ROWS(e.table)} AND ${e.sql}) = ?`,
    params: [JSON.stringify(ids), ...e.params, ids.length],
  };
}

/** Deletes the chosen rows while they are still eligible and the receipt that records it exists. */
export function deleteChunkStmt(
  db: D1Database,
  kind: PurgeKind,
  scope: Scope,
  cutoff: number,
  ids: readonly number[],
  receiptId: string,
): D1PreparedStatement {
  const e = eligible(kind, scope, cutoff);
  const where = `${IN_ROWS(e.table)} AND (${e.sql}) AND EXISTS (SELECT 1 FROM retention_receipts WHERE id = ?)`;
  const params = [JSON.stringify(ids), ...e.params, receiptId];
  switch (kind) {
    case 'feed':
      return stmt(db, `DELETE FROM event_feed WHERE ${where}`, params);
    case 'delivered':
      return stmt(db, `DELETE FROM webhook_deliveries WHERE ${where}`, params);
    case 'attempts':
    case 'testAttempts':
      return stmt(db, `DELETE FROM webhook_attempts WHERE ${where}`, params);
  }
}

/** Secrets of a rotated key are gone a day after they expire; not history, so no class or hold. */
export const purgeSecrets = (db: D1Database, before: number): Promise<number> =>
  deleteInBatches(db, 'webhook_endpoint_secrets', 'expires_at IS NOT NULL AND expires_at < ?', [
    before,
  ]);

/** Captures keep 7 days (and their hourly counters 2 days): a test bench, not history, so no class or hold. */
export async function purgeCaptures(db: D1Database, now: number): Promise<number> {
  await deleteInBatches(db, 'webhook_capture_hours', 'hour < ?', [
    Math.floor(now / 3_600_000) - 48,
  ]);
  return deleteInBatches(db, 'webhook_captures', 'created_at < ?', [
    now - WEBHOOK_CAPTURE_LIMITS.retentionDays * 86_400_000,
  ]);
}
