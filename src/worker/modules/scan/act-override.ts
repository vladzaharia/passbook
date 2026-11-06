import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import type { ScanActor } from './guard.ts';
import { isOverridable } from './outcome.ts';
import { overrideTarget, releaseClaimStmt, type ScanRow } from './repo-scans.ts';
import type { Found, Stop } from './resolve.ts';
import { defaultAction } from './resolve-outcome.ts';

const OVERRIDE_WINDOW_MS = 10 * 60_000;

export const release = (ctx: ServiceContext, scanId: string) =>
  releaseClaimStmt(ctx.env.DB, scanId).run();

export async function invalid(
  ctx: ServiceContext,
  scanId: string,
  code: string,
  message: string,
): Promise<never> {
  await release(ctx, scanId);
  throw new ValidationError(message, [], code);
}

export interface Override {
  reason: ScanReason;
  scan: ScanRow;
}

/** SA 2.6: the scan being overridden must be this actor's own recent, open heads-up. */
export async function checkOverride(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  scanId: string,
): Promise<Override | null> {
  if (!req.overrideOf) return null;
  const target = await overrideTarget(
    ctx.env.DB,
    actor.orgId,
    actor.mode,
    actor.actorKey,
    req.overrideOf,
    ctx.clock.now() - OVERRIDE_WINDOW_MS,
  );
  const reason = target?.scan.reason as ScanReason | undefined;
  if (!target || target.taken || !reason || !isOverridable(reason))
    return invalid(ctx, scanId, 'SCAN_OVERRIDE_INVALID', 'That scan cannot be let through.');
  return { reason, scan: target.scan };
}

/** Which action this request runs: named, the scanner's default, or `choose` for the desk. */
export function pickAction(
  actor: ScanActor,
  scan: ResolvedScanManifest,
  id: string,
): ResolvedScanAction | 'choose' | undefined {
  if (id === 'auto')
    return actor.settings.flow === 'choose' ? 'choose' : (defaultAction(actor, scan) ?? undefined);
  return scan.actions.find((a) => a.id === id);
}

export const approvalStop = (found: Found): Stop => ({
  stop: true,
  kind: 'heads_up',
  reason: 'needs_approval',
  pass: found.pass,
  ref: found.ref,
  at: null,
  flags: [],
  found,
});
