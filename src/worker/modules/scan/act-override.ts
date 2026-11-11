import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import { AppError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import { type ActRequest, failActionClaimStmt } from './act-claim.ts';
import type { ScanActor } from './guard.ts';
import { isOverridable } from './outcome.ts';
import { overrideEvidenceForTargetStmt } from './repo-act-override.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import { type Raw as RawScan, toScan } from './repo-scan-map.ts';
import { type Claim, pristineClaimFence, releaseClaimStmt, type ScanRow } from './repo-scans.ts';
import type { Found, Stop } from './resolve.ts';
import { defaultAction } from './resolve-outcome.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';
import { releaseClass } from './scan-event-proof-envelope.ts';

const OVERRIDE_WINDOW_MS = 10 * 60_000;

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
  authority: () => OutputPredicate,
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
  return { reason, scan, actionId, actionIdRef: data.actionIdRef, event };
}

/** SA 2.6: an invalid captured override may not release the original claim without authority. */
export async function checkOverride(
  ctx: ServiceContext,
  req: ActRequest,
  claim: Claim,
  claimAt: number,
  authority: () => OutputPredicate,
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
