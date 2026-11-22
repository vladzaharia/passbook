import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import { AppError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import { type ActRequest, failActionClaimStmt } from './act-claim.ts';
import type { ScanActor } from './guard.ts';
import { isOverridable } from './outcome.ts';
import { OVERRIDE_WINDOW_MS } from './override-scope.ts';
import { overrideEvidenceForTargetStmt } from './repo-act-override.ts';
import { type Raw as RawScan, toScan } from './repo-scan-map.ts';
import {
  type Claim,
  type PristineClaimFence,
  pristineClaimFence,
  releaseClaimStmt,
  type ScanRow,
} from './repo-scans.ts';
import type { Found, Stop } from './resolve.ts';
import { defaultAction } from './resolve-outcome.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';
import { releaseClass } from './scan-event-proof-envelope.ts';

/** Internal control flow only; never exposed as a problem response. */
export class StaleScanAuthority extends Error {}

/** The action committed, but the current response can no longer be safely confirmed. */
export class CommittedScanUnconfirmed extends AppError {
  constructor() {
    super('SCAN_UNCONFIRMED', 409, 'The scan result could not be confirmed.');
  }
}

export async function invalid(
  ctx: ServiceContext,
  claim: Claim,
  claimAt: number,
  code: string,
  message: string,
  authority: () => PristineClaimFence,
  onFailureCommitted: () => void,
): Promise<never> {
  const original = pristineClaimFence(claim);
  const [released] = await ctx.env.DB.batch([
    releaseClaimStmt(ctx.env.DB, claim.id, claimAt, authority()),
    releaseClaimStmt(ctx.env.DB, claim.id, claimAt, original),
    failActionClaimStmt(ctx.env.DB, claim, claimAt),
  ]);
  onFailureCommitted();
  if (released?.success !== true || !Array.isArray(released.results))
    throw new CommittedScanUnconfirmed();
  if (!released.results.length) throw new StaleScanAuthority();
  throw new ValidationError(message, [], code);
}

export interface Override {
  reason: ScanReason;
  scan: ScanRow;
  actionId: string;
  actionIdRef: string;
  event: EventRow;
  /** The refusing door's own `letInAgain`: the door's policy follows the scan to whoever overrides it. */
  doorLetInAgain: 'anyone' | 'manager' | 'never' | null;
  doorHardLimit: boolean;
}

/** Capture a target and its original signed event with the initial claim and candidate reads. */
export function overrideEvidenceStmt(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
): D1PreparedStatement | null {
  if (!req.overrideOf) return null;
  const since = ctx.clock.now() - OVERRIDE_WINDOW_MS;
  return overrideEvidenceForTargetStmt(ctx.env.DB, actor, req.overrideOf, since);
}

type OverrideEvidenceRow = RawScan & {
  taken: number;
  door_let_in_again: string | null;
  door_hard_limit: number | null;
  evidence_id: string;
  evidence_org_id: string;
  evidence_pass_id: string;
  evidence_mode: EventRow['mode'];
  evidence_kind: EventRow['kind'];
  evidence_device: string | null;
  evidence_actor_type: string | null;
  evidence_actor_id: string | null;
  evidence_data: string;
  evidence_at: number;
  pinned_version: string | null;
  wallet_version: number | null;
  wallet_template_version: string | null;
  approved_proof: number;
};

/** Verify the captured target before applying any waiver; the gate repeats its exact CAS. */
export async function overrideFromResult(
  ctx: ServiceContext,
  result: D1Result | { success: false } | undefined,
): Promise<Override | null> {
  const row =
    result?.success === false
      ? undefined
      : (result?.results?.[0] as OverrideEvidenceRow | undefined);
  if (
    !row ||
    row.taken === 1 ||
    typeof row.pinned_version !== 'string' ||
    row.wallet_version === null
  )
    return null;
  const scan = toScan(row);
  const reason = scan.reason as ScanReason | null;
  const actionId = scan.actionId;
  if (!reason || !isOverridable(reason) || !actionId) return null;
  const event: EventRow = {
    id: row.evidence_id,
    org_id: row.evidence_org_id,
    pass_id: row.evidence_pass_id,
    mode: row.evidence_mode,
    kind: row.evidence_kind,
    device: row.evidence_device,
    actor_type: row.evidence_actor_type,
    actor_id: row.evidence_actor_id,
    data: row.evidence_data,
    at: row.evidence_at,
  };
  if (
    !(await verifyScanEventProvenance(ctx.env, event, {
      ...scan,
      pinnedTemplateVersion: row.pinned_version,
      walletVersion: row.wallet_version,
      walletTemplateVersion: row.wallet_template_version,
      direction: scan.direction ?? null,
      presenceScope: scan.presenceScope ?? null,
    }))
  )
    return null;
  const data = JSON.parse(event.data) as {
    actionIdRef?: unknown;
    authority?: Record<string, unknown>;
  };
  if (
    typeof data.actionIdRef !== 'string' ||
    (data.authority && releaseClass(data.authority) === 'approved' && row.approved_proof !== 1)
  )
    return null;
  const door = row.door_let_in_again;
  return {
    reason,
    scan,
    actionId,
    actionIdRef: data.actionIdRef,
    event,
    doorHardLimit: row.door_hard_limit === 1,
    doorLetInAgain: door === 'anyone' || door === 'manager' || door === 'never' ? door : null,
  };
}

/** SA 2.6: an invalid captured override may not release the original claim without authority. */
export async function checkOverride(
  ctx: ServiceContext,
  req: ActRequest,
  claim: Claim,
  claimAt: number,
  authority: () => PristineClaimFence,
  captured: Override | null,
  onFailureCommitted: () => void,
): Promise<Override | null> {
  if (!req.overrideOf) return null;
  if (!captured)
    return invalid(
      ctx,
      claim,
      claimAt,
      'SCAN_OVERRIDE_INVALID',
      'That scan cannot be let through.',
      authority,
      onFailureCommitted,
    );
  return captured;
}

/** A named tap-out of a voided or ended pass (OC4): the desk's Check out, which has no action to name. */
export const tapsOut = (req: { direction?: 'in' | 'out' | undefined }, found: Found): boolean =>
  found.inactive !== undefined && req.direction === 'out';

/**
 * Which action this request runs: named, the scanner's default, or `choose` for the desk. A tap-out
 * (`exit`) never waits for a choice: it runs the check-in action.
 */
export function pickAction(
  actor: ScanActor,
  scan: ResolvedScanManifest,
  id: string,
  exit = false,
): ResolvedScanAction | 'choose' | undefined {
  if (id === 'auto') {
    if (actor.settings.flow !== 'choose') return defaultAction(actor, scan) ?? undefined;
    return exit ? scan.actions.find((a) => a.kind === 'check_in') : 'choose';
  }
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
