import type { EventActorType } from '../../../shared/contracts/events.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import type { Pass } from '../passes/repo-map.ts';

/**
 * The scan outcome hook for Workbench Simulate: the ledger row a real scan writes (SA 8.5), at the
 * gate "Workbench". It writes no `scans` row, so counts, presence and the scanner feed stay as they were.
 */
export async function recordSimulatedScan(
  ctx: ServiceContext,
  input: {
    pass: Pass;
    outcome: 'ok' | 'refused';
    id: string;
    requestId: string;
    actor: { type: EventActorType; id: string | null };
  },
): Promise<void> {
  const { pass, outcome } = input;
  await recordPassEvent(ctx, {
    id: input.id,
    orgId: pass.orgId,
    passId: pass.id,
    mode: pass.mode,
    kind: outcome === 'ok' ? 'scan.checked_in' : 'scan.rejected',
    actor: input.actor,
    data: {
      scanId: ctx.ids.id(),
      actionKind: outcome === 'ok' ? 'check_in' : null,
      outcome,
      reason: outcome === 'ok' ? null : 'not_accepted',
      method: 'manual',
      version: pass.version,
      gate: 'Workbench',
      simulated: true,
      requestId: input.requestId,
    },
  });
}
