// One auto tap-out as a job grant (SA §20.8): claim a system `scans` row, exit the in row the cron read
// (compare and swap on its `last_scan_id`) and every row below, then finalize the claim or drop it.
import type { Grant } from '../../../platform/authority.ts';
import { jobGrant } from '../../../platform/authority.ts';
import { not } from '../../../platform/authority-cond.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import type { EventRow } from '../../events/repo.ts';
import { includeSystemRetentionProof } from '../repo-scan-retention-part.ts';
import {
  prepareSystemScanRetentionProof,
  type ScanRetentionSnapshot,
} from '../scan-retention-proof.ts';
import { scanIs } from '../scan-write-grant.ts';
import { markOutEffect } from './repo-mark-out.ts';
import type { DueRow } from './repo-reads.ts';
import type { ExitPlan } from './rules.ts';
import { addExit } from './service.ts';

export const OCCUPANCY_JOB = 'scan.occupancy';
export const OCCUPANCY_ACTOR_KEY = 'sys:occupancy';
const TABLES = [
  'scans',
  'pass_events',
  'scan_presence',
  'scan_place_revs',
  'scan_retention_proofs',
];

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

export async function exitGrant(
  ctx: ServiceContext,
  row: DueRow,
  plan: ExitPlan,
  cause: OutCause,
  now: number,
): Promise<Grant> {
  const g = grantFor(ctx, row);
  const scanId = ctx.ids.id();
  const key = autoKey(row);
  const eventId = row.scope.startsWith('event:') ? row.scope.slice(6) : null;
  const effect = await markOutEffect(
    ctx.env.DB,
    { id: scanId, passId: row.pass_id, place: row.scope },
    row.org_id,
  );
  const event: EventRow = {
    id: ctx.ids.ordered(now),
    org_id: row.org_id,
    pass_id: row.pass_id,
    mode: row.mode,
    kind: 'scan.checked_out',
    device: null,
    actor_type: 'system',
    actor_id: 'occupancy',
    data: JSON.stringify({
      scanId,
      actionKind: 'check_in',
      outcome: 'ok',
      method: 'auto',
      direction: 'out',
      outCause: cause,
      exit: cause,
      ...(row.scope.startsWith('zone:') ? { zoneId: row.scope.slice(5) } : {}),
      place: row.scope,
      eventId,
      scannerId: null,
      staffId: null,
      authority: { kind: 'system', job: OCCUPANCY_JOB, cause },
      ...(effect ? { effect } : {}),
    }),
    at: now,
  };
  const facts: ScanRetentionSnapshot = {
    id: scanId,
    orgId: row.org_id,
    mode: row.mode,
    templateId: row.template_id,
    scannerId: null,
    eventId,
    actorType: 'system',
    actorId: 'occupancy',
    actorKey: OCCUPANCY_ACTOR_KEY,
    staffId: null,
    approvedBy: null,
    method: 'auto',
    state: 'done',
    outcome: 'ok',
    reason: null,
    actionId: null,
    actionKind: 'check_in',
    direction: 'out',
    passVersion: null,
    presenceScope: row.scope,
    at: now,
    undoes: null,
    override: false,
    outCause: cause,
  };
  const retention = await prepareSystemScanRetentionProof(ctx.env, event, facts);
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
      event_id: eventId,
    },
    where: { id: scanId, state: 'pending', at: now },
    when: [won],
    returning: ['id'],
  });
  // The ledger row of a normal tap-out and its proof, which names the job as the authority.
  g.insertSelect(
    'pass_events',
    ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
    [
      event.id,
      event.pass_id,
      event.kind,
      event.device,
      event.actor_type,
      event.actor_id,
      event.data,
      event.at,
    ],
    { when: [scanIs(scanId, { state: 'done', outcome: 'ok' })], returning: ['id'] },
  );
  includeSystemRetentionProof(g, retention, [scanIs(scanId, { state: 'done' })]);
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
