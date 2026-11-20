import { jobGrant } from '../../platform/authority.ts';
import { type Check, exactlyOne } from '../../platform/authority-checks.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { PreparedReceipt } from '../retention/receipt-service.ts';
import type { Scope } from '../retention/repo-sweep.ts';

export interface RetentionVisit {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
}

const CODES = {
  stale: 'VISITOR_CHANGED',
  lineage: 'VISITOR_CHANGED',
  retention: 'VISITOR_HELD',
  config: 'VISITOR_RECEIPT',
};

/** An org-wide hold, or a hold on this visit's pass, keeps the visit. */
const heldSql = (pass: string, org: string) =>
  `EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = ${org}
     AND (h.pass_id IS NULL OR h.pass_id = ${pass}))`;

/** Refuses the commit when a hold landed after the page was read. */
const notHeld = (visitId: string): Check => ({
  reason: 'retention',
  ok: (b) =>
    `NOT ${heldSql('(SELECT v.pass_id FROM visitors v WHERE v.id = ' + b.bind(visitId) + ')', 'a.org_id')}`,
});

/** Refuses the commit unless the receipt that records it is in the same batch. */
const receiptExists = (receiptId: string): Check => ({
  reason: 'config',
  ok: (b) => `EXISTS (SELECT 1 FROM retention_receipts WHERE id = ${b.bind(receiptId)})`,
});

/** Visits whose window ended before `before`, in id order after the cursor, not held. */
export function endedVisits(
  db: D1Database,
  before: number,
  after: string,
  limit: number,
  scope: Scope,
) {
  const where =
    scope.kind === 'org'
      ? { sql: 'v.org_id = ?', param: scope.orgId }
      : {
          sql: 'v.org_id NOT IN (SELECT value FROM json_each(?))',
          param: JSON.stringify(scope.exclude),
        };
  return all<RetentionVisit>(
    db,
    `SELECT v.id, v.org_id, v.mode FROM visitors v
     WHERE v.window_until < ? AND v.id > ? AND ${where.sql} AND NOT ${heldSql('v.pass_id', 'v.org_id')}
     ORDER BY v.id LIMIT ?`,
    [before, after, where.param, limit],
  );
}

/** The visit row goes in the batch that holds its receipt; a hold or a missing receipt refuses it. */
export async function deleteVisit(
  ctx: ServiceContext,
  v: RetentionVisit,
  receipt: PreparedReceipt,
): Promise<void> {
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.visitors.retention_delete',
    job: 'visitors',
    orgId: v.org_id,
    mode: v.mode,
    target: v.id,
    tables: ['visitors'],
    codes: CODES,
    checks: [
      exactlyOne('visitors', { id: v.id }, undefined, 'stale'),
      notHeld(v.id),
      receiptExists(receipt.receipt.id),
    ],
  });
  g.delete('visitors', { where: { id: v.id }, require: 'one' });
  await g.commitAfter(receipt.stmt);
}
