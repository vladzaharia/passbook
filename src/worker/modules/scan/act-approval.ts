import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { answerWithoutRow } from './act-answer.ts';
import { commitCheckIn } from './act-check-in.ts';
import { type ActRequest, claimOf, failActionClaimStmt } from './act-claim.ts';
import {
  approvalStop,
  CommittedScanUnconfirmed,
  type Override,
  StaleScanAuthority,
} from './act-override.ts';
import type { ActionHistoryPreflight, ActionPreflight } from './act-preflight.ts';
import { actionCsrfAt } from './act-snapshot.ts';
import type { StopContext } from './act-stop.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import { approvalReservationPredicate } from './repo-act-approval.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { credentialTombstonePredicate } from './repo-gates.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import { ObservedScanAmbiguity } from './repo-scan-effect.ts';
import { pristineClaimFence, releaseClaimStmt } from './repo-scans.ts';
import type { Found } from './resolve.ts';
import { overridePolicyKind, scanPolicy } from './rules.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { type PinStaffSnapshot, preparePinReservation } from './staff-pin.ts';

interface ActionApprovalInput {
  ctx: ServiceContext;
  actor: ScanActor;
  authorityActor: ScanActor;
  req: ActRequest;
  scanId: string;
  claimAt: number;
  requestHash: string;
  credentials: CredentialTombstoneSnapshot;
  csrfSnapshot: ActorCsrfSnapshot;
  found: Found;
  action: ResolvedScanAction;
  override: Override | null;
  preflight: ActionPreflight;
  history: ActionHistoryPreflight | null;
  photo: PreparedPhotoGrant | null;
  undoWindow: number;
  approver: PinStaffSnapshot | null;
  stopFor(action: ResolvedScanAction | null): StopContext;
  onFailureCommitted(): void;
}

/** Reserve a PIN only after the evaluated action actually requires approval. */
export async function executeApprovedAction(input: ActionApprovalInput): Promise<ScanEvaluation> {
  const {
    ctx,
    actor,
    authorityActor,
    req,
    scanId,
    claimAt,
    requestHash,
    credentials,
    csrfSnapshot,
    found,
    action,
    override,
    preflight,
    history,
    photo,
    undoWindow,
    approver,
    stopFor,
    onFailureCommitted,
  } = input;
  const pa = policyActor(actor);
  const checks = [
    scanPolicy(pa, { kind: 'act', minRole: action.minRole }),
    ...(override
      ? [
          scanPolicy(pa, {
            kind: overridePolicyKind(override.reason),
          }),
        ]
      : []),
  ];
  if (
    checks.some((check) => !check.allow) &&
    (!checks.every((check) => check.allow || check.why === 'needs_approval') || !req.approval)
  ) {
    return {
      outcome: await answerWithoutRow(stopFor(action), approvalStop(found), {
        actor: authorityActor,
        event: found.admission?.event ?? null,
        templateId: found.pass.templateId,
        adminEventTemplates:
          authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
        passFence: preflight.passFence,
      }),
      evaluatedSnapshot: found.liveCandidate ?? null,
      credentialContext: credentials,
    };
  }
  const approval = checks.some((check) => !check.allow) ? req.approval : undefined;
  const now = ctx.clock.now();
  const csrf = actionCsrfAt(authorityActor, csrfSnapshot, now);
  if (!csrf || !found.liveCandidate) throw new StaleScanAuthority();
  const ownedClaim = claimOf(ctx, authorityActor, req, scanId, requestHash);
  const original = pristineClaimFence(ownedClaim);
  const actorFence = actorAuthorityPredicate({
    actor: authorityActor,
    now,
    event: found.admission?.event ?? null,
    templateId: found.pass.templateId,
    adminEventTemplates: authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
  });
  const tokens = credentialTombstonePredicate(
    authorityActor.orgId,
    authorityActor.mode,
    credentials.credentialTombstoneRefs,
    credentials.credentialKeysetCommitment,
  );
  const template = scanCandidateTemplateReadPredicate(found.liveCandidate);
  const guard = approvalReservationPredicate(
    scanId,
    claimAt,
    original,
    actorFence,
    csrf,
    tokens,
    template,
  );
  const reservation = approval
    ? preparePinReservation(
        ctx,
        {
          scannerId: authorityActor.scanner?.id ?? authorityActor.actorKey,
          orgId: authorityActor.orgId,
          staffId: approval.staffId,
        },
        guard,
      )
    : null;
  let failureCommitted = false;
  const recordFailure = () => {
    failureCommitted = true;
    onFailureCommitted();
  };
  try {
    const { held } = preflight;
    const results = reservation ? await ctx.env.DB.batch(reservation.stmts) : [];
    const verified =
      reservation && approval
        ? await reservation.verify(results, approver, approval.pin, true, {
            failureStatements: [failActionClaimStmt(ctx.env.DB, ownedClaim, claimAt)],
            onFailureCommitted: recordFailure,
          })
        : null;
    if (reservation && !verified) throw new StaleScanAuthority();
    const outcome = await commitCheckIn({
      ctx,
      actor,
      authorityActor,
      req,
      scanId,
      claimAt,
      requestHash,
      found,
      action,
      override,
      approvedBy: verified?.id ?? null,
      approvedAuthEpoch: verified?.authEpoch ?? null,
      reservation,
      credentialTombstoneRefs: credentials.credentialTombstoneRefs,
      credentialKeysetCommitment: credentials.credentialKeysetCommitment,
      csrfSnapshot,
      undoWindow,
      preflight,
      held,
      history,
      photo,
      onFailureCommitted: recordFailure,
    });
    return {
      outcome,
      evaluatedSnapshot: found.liveCandidate ?? null,
      credentialContext: credentials,
    };
  } catch (error) {
    if (reservation && !failureCommitted && !(error instanceof CommittedScanUnconfirmed))
      await reservation.refund({
        failureStatements: [
          ...(error instanceof StaleScanAuthority
            ? [releaseClaimStmt(ctx.env.DB, scanId, claimAt, pristineClaimFence(ownedClaim))]
            : []),
          failActionClaimStmt(
            ctx.env.DB,
            ownedClaim,
            claimAt,
            error instanceof ObservedScanAmbiguity,
          ),
        ],
        onFailureCommitted: recordFailure,
      });
    throw error;
  } finally {
    await reservation?.refund();
  }
}
