import { jobGrant } from '../../platform/authority.ts';
import { type Check, exactlyOne } from '../../platform/authority-checks.ts';
import { lte } from '../../platform/authority-expr.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PreparedReceipt } from '../retention/receipt-service.ts';
import type { Scope } from '../retention/repo-sweep.ts';
import { CONNECTION_CODES } from './repo-grants.ts';

export interface RetentionFile {
  id: string;
  org_id: string;
  connection_id: string | null;
  state: string;
}

const COLUMNS = 'id, org_id, connection_id, state';
/** The newest superseded revisions of a connection that retention keeps for removal diffs. */
export const SUPERSEDED_KEPT = 2;

/** An org-wide hold, or a hold on any pass the connection issued, keeps its files. */
const heldSql = (org: string, connection: string) =>
  `EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = ${org}
     AND (h.pass_id IS NULL OR h.pass_id IN (SELECT p.id FROM passes p WHERE p.connection_id = ${connection})))`;
const notHeld = (fileId: string): Check => ({
  reason: 'retention',
  ok: (b) =>
    `NOT ${heldSql('a.org_id', `(SELECT connection_id FROM connection_files WHERE id = ${b.bind(fileId)})`)}`,
});
const receiptExists = (receiptId: string): Check => ({
  reason: 'config',
  ok: (b) => `EXISTS (SELECT 1 FROM retention_receipts WHERE id = ${b.bind(receiptId)})`,
});

const scopeSql = (scope: Scope) =>
  scope.kind === 'org'
    ? { sql: 'f.org_id = ?', param: scope.orgId }
    : {
        sql: 'f.org_id NOT IN (SELECT value FROM json_each(?))',
        param: JSON.stringify(scope.exclude),
      };

/** Drafts and pending revisions past their 23 hours. */
export const unfinishedDue = (db: D1Database, now: number, after: string, limit: number) =>
  all<RetentionFile>(
    db,
    `SELECT ${COLUMNS} FROM connection_files
     WHERE state IN ('draft', 'pending') AND expires_at <= ? AND id > ? ORDER BY id LIMIT ?`,
    [now, after, limit],
  );

/** Superseded revisions beyond the newest two of their connection, or older than `before`. */
export function supersededDue(
  db: D1Database,
  before: number,
  after: string,
  limit: number,
  scope: Scope,
) {
  const sc = scopeSql(scope);
  return all<RetentionFile>(
    db,
    `SELECT f.id, f.org_id, f.connection_id, f.state FROM connection_files f
     WHERE f.state = 'superseded' AND f.id > ? AND ${sc.sql} AND NOT ${heldSql('f.org_id', 'f.connection_id')}
       AND (f.superseded_at < ? OR (SELECT COUNT(*) FROM connection_files n
         WHERE n.connection_id = f.connection_id AND n.state = 'superseded' AND n.revision > f.revision) >= ${SUPERSEDED_KEPT})
     ORDER BY f.id LIMIT ?`,
    [after, sc.param, before, limit],
  );
}

/** Rows of uploads that ended unbound (expired or discarded) a while ago; their objects are already gone. */
export const endedBefore = (db: D1Database, before: number, after: string, limit: number) =>
  all<RetentionFile>(
    db,
    `SELECT ${COLUMNS} FROM connection_files
     WHERE state IN ('expired', 'discarded') AND COALESCE(expires_at, created_at) < ? AND id > ?
     ORDER BY id LIMIT ?`,
    [before, after, limit],
  );

/** Of these ids, the ones a row still names. */
export async function idsWithRows(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await all<{ id: string }>(
    db,
    'SELECT id FROM connection_files WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(ids)],
  );
  return new Set(rows.map((r) => r.id));
}

function retentionGrant(ctx: ServiceContext, f: RetentionFile, purpose: string, checks: Check[]) {
  return jobGrant(ctx, {
    purpose: `org_mode.job.connection_files.${purpose}`,
    job: 'connection-files',
    orgId: f.org_id,
    mode: 'live',
    target: f.id,
    tables: ['connection_files'],
    codes: CONNECTION_CODES,
    checks,
  });
}

/** A draft ends `expired`; a pending revision ends `discarded`. Both only while past their time. */
export async function endUnfinished(
  ctx: ServiceContext,
  f: RetentionFile,
  now: number,
): Promise<void> {
  const g = retentionGrant(ctx, f, 'expire', [
    exactlyOne(
      'connection_files',
      { id: f.id, state: f.state, expires_at: lte(now) },
      undefined,
      'stale',
    ),
  ]);
  g.update('connection_files', {
    where: { id: f.id, state: f.state },
    set: { state: f.state === 'draft' ? 'expired' : 'discarded' },
    require: 'one',
  });
  await g.commit();
}

/** The row goes in the batch that holds its receipt; a hold or a missing receipt refuses it. */
export async function deleteSuperseded(
  ctx: ServiceContext,
  f: RetentionFile,
  receipt: PreparedReceipt,
): Promise<void> {
  const g = retentionGrant(ctx, f, 'retire', [
    exactlyOne('connection_files', { id: f.id, state: 'superseded' }, undefined, 'stale'),
    notHeld(f.id),
    receiptExists(receipt.receipt.id),
  ]);
  g.delete('connection_files', { where: { id: f.id, state: 'superseded' }, require: 'one' });
  await g.commitAfter(receipt.stmt);
}

export async function deleteEnded(ctx: ServiceContext, f: RetentionFile): Promise<void> {
  const g = retentionGrant(ctx, f, 'clear', [
    exactlyOne('connection_files', { id: f.id, state: f.state }, undefined, 'stale'),
  ]);
  g.delete('connection_files', { where: { id: f.id, state: f.state }, require: 'one' });
  await g.commit();
}
