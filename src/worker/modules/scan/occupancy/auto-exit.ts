// One auto tap-out as a job grant (SA §20.8): claim a system `scans` row, exit the in row the cron read
// (compare and swap on its `last_scan_id`) and every row below, then finalize the claim or drop it.
import type { Grant } from '../../../platform/authority.ts';
import { jobGrant } from '../../../platform/authority.ts';
import { not } from '../../../platform/authority-cond.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { scanIs } from '../scan-write-grant.ts';
import type { DueRow } from './repo-reads.ts';
import type { ExitPlan } from './rules.ts';
import { addExit } from './service.ts';

export const OCCUPANCY_JOB = 'scan.occupancy';
export const OCCUPANCY_ACTOR_KEY = 'sys:occupancy';
const TABLES = ['scans', 'pass_events', 'scan_presence', 'scan_place_revs'];

export type OutCause = 'stay' | 'clear' | 'zone';

const grantFor = (ctx: ServiceContext, row: DueRow): Grant =>
  jobGrant(ctx, {
    purpose: 'org_mode.job.scan.occupancy',
    job: OCCUPANCY_JOB,
    orgId: row.org_id,
    mode: row.mode,
    tables: TABLES,
  });

/** The idempotency key: one auto exit per in row (its last entry), however often the cron retries. */
export const autoKey = (row: DueRow) => `auto:${row.pass_id}:${row.scope}:${row.last_entry_at}`;

export function exitGrant(
  ctx: ServiceContext,
  row: DueRow,
  plan: ExitPlan,
  cause: OutCause,
  now: number,
): Grant {
  const g = grantFor(ctx, row);
  const scanId = ctx.ids.id();
  const key = autoKey(row);
  g.upsert(
    'scans',
    [
      'id',
      'actor_type',
      'actor_id',
      'actor_key',
      'idempotency_key',
      'request_hash',
      'method',
      'state',
      'client_ts',
      'at',
    ],
    [scanId, 'system', 'occupancy', OCCUPANCY_ACTOR_KEY, key, key, 'auto', 'pending', now, now],
    { doNothing: true, returning: ['id'] },
  );
  const { won } = addExit(g, {
    passId: row.pass_id,
    scanId,
    now,
    plan,
    lastScanId: row.last_scan_id,
    when: [scanIs(scanId, { state: 'pending', at: now })],
  });
  g.update('scans', {
    set: {
      state: 'done',
      outcome: 'ok',
      pass_id: row.pass_id,
      template_id: row.template_id,
      action_kind: 'check_in',
      direction: 'out',
      presence_scope: row.scope,
      out_cause: cause,
    },
    where: { id: scanId, state: 'pending', at: now },
    when: [won],
    returning: ['id'],
  });
  // The ledger row of a normal tap-out, without a signed proof: no scanner or action was involved.
  g.insertSelect(
    'pass_events',
    ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
    [
      ctx.ids.ordered(now),
      row.pass_id,
      'scan.checked_out',
      null,
      'system',
      'occupancy',
      JSON.stringify({
        scanId,
        actionKind: 'check_in',
        outcome: 'ok',
        method: 'auto',
        direction: 'out',
        outCause: cause,
        place: row.scope,
        eventId: null,
        scannerId: null,
        staffId: null,
      }),
      now,
    ],
    { when: [scanIs(scanId, { state: 'done', outcome: 'ok' })], returning: ['id'] },
  );
  // A tap got there first: nothing happened, so no record of it.
  g.delete('scans', { where: { id: scanId, state: 'pending', at: now }, when: [not(won)] });
  return g;
}

/** The stored due time followed old settings: put the row back on the zone's current one. */
export function rearmGrant(ctx: ServiceContext, row: DueRow, due: number | null): Grant {
  const g = grantFor(ctx, row);
  g.update('scan_presence', {
    set: { due_at: due },
    where: { pass_id: row.pass_id, scope: row.scope, last_scan_id: row.last_scan_id, state: 'in' },
  });
  return g;
}
