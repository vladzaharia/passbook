import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startsVisit } from './access.ts';
import type { FoundAccess } from './access-types.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { ActionHistoryPreflight } from './act-preflight.ts';
import type { ScanActor } from './actor.ts';
import { historyPlan } from './card.ts';
import { preparePlannedDisplayHistoryProof } from './display-history-pending.ts';
import { appendPlannedDisplayHistory, rebindDisplayHistoryRead } from './display-history-plan.ts';
import type { Found } from './resolve.ts';
import {
  type DisplayHistoryPlan,
  displayNeedsFor,
  displayRequiresHistory,
  prepareDisplayHistory,
} from './scan-display-history.ts';
import type { PreparedScanRetentionProof } from './scan-retention-proof.ts';
import type { Finalize } from './scan-write-statements.ts';

export type Finalizer = (
  outcome: 'ok' | 'heads_up' | 'refused',
  reason: ScanReason | null,
  visit?: boolean,
) => Finalize;

/** How the scan row closes, per outcome: what it was, where it counted and whether it was a visit. */
export function checkInFinalizer(i: {
  scanId: string;
  claimAt: number;
  found: Found;
  action: ResolvedScanAction;
  overrideOf: string | null;
  approvedBy: string | null;
  eventId: string | null;
  access: FoundAccess | null;
  /** The place, or the admission's presence scope: where an ok scan counted. */
  presenceScope: string | undefined;
}): Finalizer {
  const { found, action, access, presenceScope } = i;
  const place = found.occupancy ?? null;
  return (outcome, reason, visit) => ({
    id: i.scanId,
    claimAt: i.claimAt,
    outcome,
    reason,
    passId: found.pass.id,
    templateId: found.pass.templateId,
    actionId: action.id,
    actionKind: action.kind,
    passVersion: found.pass.version,
    overrideOf: outcome === 'ok' ? i.overrideOf : null,
    approvedBy: outcome === 'ok' ? i.approvedBy : null,
    direction: place?.direction ?? found.admission?.state.direction,
    ...(outcome === 'ok' && presenceScope !== undefined ? { presenceScope } : {}),
    // Leaving is never a visit, on the card or in the history.
    ...(outcome === 'ok' && place?.direction === 'out' ? { noVisit: true } : {}),
    ...(i.eventId ? { eventId: i.eventId } : {}),
    ...(access
      ? {
          access: {
            zoneId: access.zoneId,
            plan: access.decision.access.plan.id,
            visit: outcome === 'ok' ? (visit ?? false) : null,
          },
        }
      : {}),
  });
}

/** The result screen's history, planned before the grant exists: it only needs values. */
export async function planCheckInDisplay(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  i: {
    history: ActionHistoryPreflight | null;
    retention: PreparedScanRetentionProof;
    final: Finalize;
    access: FoundAccess | null;
    now: number;
  },
): Promise<DisplayHistoryPlan> {
  if (!displayRequiresHistory(found)) return historyPlan(ctx, actor, found);
  const { history, access } = i;
  if (!history || !rebindDisplayHistoryRead(history.preloaded, actor, found))
    throw new StaleScanAuthority();
  const planned = await preparePlannedDisplayHistoryProof(
    history.source,
    actor,
    found,
    i.retention,
    i.final,
  );
  // A grant inside a visit is not a visit, and a tap-out never is: the history will not count them.
  const counted = found.occupancy?.direction !== 'out' && (!access || startsVisit(access, i.now));
  if (!planned || (counted && !appendPlannedDisplayHistory(history.preloaded, planned)))
    throw new StaleScanAuthority();
  return prepareDisplayHistory(ctx, actor, found, displayNeedsFor(found), history.preloaded);
}
