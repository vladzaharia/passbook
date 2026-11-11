import type { Json } from '../../../shared/contracts/common.ts';
import type { EventKind } from '../../../shared/contracts/events.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { writeEvent } from '../../platform/analytics.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sanitizeEventData } from '../events/record.ts';
import type { EventRow } from '../events/repo.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './guard.ts';

export interface LedgerFacts {
  pass: Pass;
  scanId: string;
  action: ResolvedScanAction | null;
  outcome: 'ok' | 'heads_up' | 'refused';
  reason: string | null;
  method: string;
  override: boolean;
  approvedBy: string | null;
  direction?: 'in' | 'out';
}

const KIND: Record<LedgerFacts['outcome'], EventKind> = {
  ok: 'scan.checked_in',
  heads_up: 'scan.heads_up',
  refused: 'scan.rejected',
};

/** A `pass_events` row for a scan (SA 8.5): ids, enums and numbers, never a name, email or code. */
export function ledgerRow(ctx: ServiceContext, actor: ScanActor, f: LedgerFacts): EventRow {
  const at = ctx.clock.now();
  const data: Record<string, Json> = {
    scanId: f.scanId,
    actionKind: f.action?.kind ?? null,
    outcome: f.outcome,
    reason: f.reason,
    method: f.method,
    version: f.pass.version,
    eventId: actor.event?.id ?? null,
    scannerId: actor.scanner?.id ?? null,
    staffId: actor.staff?.id ?? null,
    approvedBy: f.approvedBy,
    override: f.override,
    offline: false,
    notified: false,
    ...(f.direction ? { direction: f.direction } : {}),
  };
  return {
    id: ctx.ids.ordered(at),
    org_id: f.pass.orgId,
    pass_id: f.pass.id,
    mode: f.pass.mode,
    kind: f.outcome === 'ok' && f.direction === 'out' ? 'scan.checked_out' : KIND[f.outcome],
    device: null,
    actor_type: actor.actor.type,
    actor_id: actor.actor.id,
    data: JSON.stringify(sanitizeEventData(data)),
    at,
  };
}

/** The Analytics Engine point for one answer. Never throws. */
export function recordResult(
  ctx: ServiceContext,
  actor: ScanActor,
  templateId: string | null,
  outcome: string,
  mode = actor.mode,
): void {
  writeEvent(
    ctx.env,
    { event: 'scan.result', orgId: actor.orgId, templateId, outcome, mode },
    ctx.log,
  );
}
