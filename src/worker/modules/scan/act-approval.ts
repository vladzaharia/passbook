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
import type { StopContext } from './act-stop.ts';
import { finishEffectStop, valueRefusal } from './act-value-guard.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { policyActor } from './dto.ts';
import { amountOf, ScanEffectStop } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import { hardLimited } from './occupancy/place.ts';
import { approvalReservationPredicate } from './repo-act-approval.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { passAnswerFence, underAuthorityCtes } from './repo-read-fences.ts';
import { ObservedScanAmbiguity } from './repo-scan-effect.ts';
import { pristineClaimFence, releaseClaimStmt } from './repo-scans.ts';
import type { Found } from './resolve.ts';
import { deskMayApprove, overridePolicyKind, scanPolicy } from './rules.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { ANY_MANAGER, type PinStaffSnapshot, preparePinReservation } from './staff-pin.ts';

interface ActionApprovalInput {
  ctx: ServiceContext;
  actor: ScanActor;
  authorityActor: ScanActor;
  req: ActRequest;
  scanId: string;
  claimAt: number;
  requestHash: string;
  credentials: CredentialTombstoneSnapshot;
  found: Found;
  action: ResolvedScanAction;
  override: Override | null;
  preflight: ActionPreflight;
  history: ActionHistoryPreflight | null;
  photo: PreparedPhotoGrant | null;
  undoWindow: number;
  approver: readonly PinStaffSnapshot[];
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
  const settleEffectStop = (stop: ScanEffectStop) =>
    finishEffectStop(
      stopFor(action),
      found,
      action,
      stop,
      {
        actor: authorityActor,
        event: found.admission?.event ?? null,
        templateId: found.pass.templateId,
        passFence: preflight.passFence,
      },
      req,
    );
  const sized = action.kind === 'add' || action.kind === 'take';
  const max = typeof action.amount === 'object' ? action.amount.max : null;
  // A type that asks for a Manager is never satisfied by a Desk PIN, whatever the session allows for actions.
  const deskOk =
    actor.tag?.confirm !== 'manager' &&
    deskMayApprove(
      pa.settings,
      action,
      sized && max !== null && amountOf(action, req.amount) > max,
    );
  const checks = [
    scanPolicy(pa, {
      kind: 'act',
      minRole: action.minRole,
      ...(sized
        ? {
            amount: amountOf(action, req.amount),
            max,
          }
        : {}),
    }),
    ...(actor.tag?.confirm === 'manager' ? [scanPolicy(pa, { kind: 'tag_confirm' })] : []),
    ...(override
      ? [
          // The door's own letInAgain follows the scan to whoever overrides it; `never` closes it for the desk.
          scanPolicy(
            {
              ...pa,
              settings: {
                ...pa.settings,
                hardLimit:
                  override.doorHardLimit ||
                  (found.occupancy ? hardLimited(found.occupancy.spec) : false) ||
                  found.admission?.event?.hardLimit === true,
                ...(override.doorLetInAgain ? { letInAgain: override.doorLetInAgain } : {}),
              },
            },
            { kind: overridePolicyKind(override.reason, override.scan.outcome) },
          ),
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
        passFence: preflight.passFence,
      }),
      evaluatedSnapshot: found.liveCandidate ?? null,
      credentialContext: credentials,
    };
  }
  if (action.kind !== 'check_in') {
    const refusal = await valueRefusal(ctx, actor, found, action, req);
    if (refusal)
      return {
        outcome: await settleEffectStop(refusal),
        evaluatedSnapshot: found.liveCandidate ?? null,
        credentialContext: credentials,
      };
  }
  const approval = checks.some((check) => !check.allow) ? req.approval : undefined;
  const now = ctx.clock.now();
  if (!found.liveCandidate) throw new StaleScanAuthority();
  const ownedClaim = claimOf(ctx, authorityActor, req, scanId, requestHash);
  const original = pristineClaimFence(ownedClaim);
  // The actor, the pass the answer read and the unretired credential, all as of now.
  const inner = passAnswerFence(authorityActor, found.liveCandidate, {
    photo: false,
    refs: credentials.credentialTombstoneRefs,
    staged: true,
  });
  if (!inner) throw new StaleScanAuthority();
  const staged = underAuthorityCtes(
    scanReadAuthority(authorityActor, {
      now,
      event: found.admission?.event ?? null,
      templateId: found.pass.templateId,
    }),
    inner,
  );
  const guard = approvalReservationPredicate(scanId, claimAt, original, {
    sql: staged.sql,
    params: [],
    ctes: staged.ctes,
    cteParams: staged.params,
  });
  const reservation = approval
    ? preparePinReservation(
        ctx,
        {
          scannerId: authorityActor.scanner?.id ?? authorityActor.actorKey,
          orgId: authorityActor.orgId,
          staffId: approval.staffId ?? ANY_MANAGER,
          ...(approval.staffId ? {} : { testedManagers: approver.length }),
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
    const failure = {
      failureStatements: [failActionClaimStmt(ctx.env.DB, ownedClaim, claimAt)],
      onFailureCommitted: recordFailure,
    };
    // No one approves their own request, unless no one else can: then the requester confirms with `alone`
    // and their own PIN (two staff who can approve still mean two people).
    const self = authorityActor.staff?.id ?? null;
    const others = approver.filter((a) => a.id !== self);
    const mine = approver.find((a) => a.id === self) ?? null;
    const alone = approval?.alone === true && others.length === 0 && mine !== null;
    const pool = alone && mine ? [mine] : others;
    const results = reservation ? await ctx.env.DB.batch(reservation.stmts) : [];
    const verified =
      reservation && approval
        ? await (approval.staffId && !alone
            ? reservation.verify(results, pool[0] ?? null, approval.pin, true, failure, deskOk)
            : reservation.verifyAny(results, pool, approval.pin, failure, false, deskOk))
        : null;
    if (reservation && !verified) throw new StaleScanAuthority();
    const commit = () =>
      commitCheckIn({
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
        approvedRole: verified?.role ?? null,
        approvedAuthEpoch: verified?.authEpoch ?? null,
        approvedSole: alone,
        reservation,
        credentialTombstoneRefs: credentials.credentialTombstoneRefs,
        credentialKeysetCommitment: credentials.credentialKeysetCommitment,
        undoWindow,
        preflight,
        held,
        history,
        photo,
        onFailureCommitted: recordFailure,
      });
    const outcome = await commit().catch((error: unknown) => {
      if (error instanceof ScanEffectStop) return settleEffectStop(error);
      throw error;
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
