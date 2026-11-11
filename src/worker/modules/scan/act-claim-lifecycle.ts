import { AppError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { attempt } from './act-attempt.ts';
import { type ActRequest, claimOf, rememberHistoryCapacities } from './act-claim.ts';
import { claimGrant, keysetOnGrant } from './act-claim-grant.ts';
import { quarantineOnGrant, reopenOnGrant } from './act-claim-reopen.ts';
import {
  CommittedScanUnconfirmed,
  overrideEvidenceStmt,
  overrideFromResult,
  StaleScanAuthority,
} from './act-override.ts';
import { replayOutcome } from './act-replay.ts';
import { actionCsrfAt } from './act-snapshot.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { type CredentialTombstoneSnapshot, credentialInputValid } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { unknownOutcome } from './outcome.ts';
import { recoverScans } from './recover.ts';
import {
  claimAuthorityPredicate,
  claimOutputPredicateStmt,
  initialClaimCredentialPredicate,
  observedClaimCollisionPredicate,
} from './repo-act-claim-lifecycle.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { isAssetGrantAuthorityFailure } from './repo-asset-grants.ts';
import { credentialTombstonePredicate } from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import { ObservedScanAmbiguity } from './repo-scan-effect.ts';
import {
  failScanStmt,
  pristineClaimFence,
  quarantineGateClaimStmt,
  releaseClaimStmt,
  type ScanRow,
} from './repo-scans.ts';
import { staffStatement } from './repo-staff.ts';
import { planCandidateReads } from './resolve-candidates.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { pinStaffFromResult } from './staff-pin.ts';

export const SCAN_IN_PROGRESS_MS = 15_000;

export const staleScanAuthority = () => new StaleScanAuthority();
export function actionClaimAuthority(
  actor: ScanActor,
  req: ActRequest,
  credentials: CredentialTombstoneSnapshot,
  csrfSnapshot: ActorCsrfSnapshot,
  now: number,
  initialize: boolean,
) {
  const csrf = actionCsrfAt(actor, csrfSnapshot, now);
  if (!csrf) return null;
  const actorFence = actorAuthorityPredicate({
    actor,
    now,
    event: actor.event,
    adminEventTemplates: actor.principal === 'admin' && !req.scope?.templateIds?.length,
  });
  const credentialsFence = initialize
    ? initialClaimCredentialPredicate(credentials.credentialKeysetCommitment)
    : credentialTombstonePredicate(
        actor.orgId,
        actor.mode,
        credentials.credentialTombstoneRefs,
        credentials.credentialKeysetCommitment,
      );
  return claimAuthorityPredicate(actorFence, csrf, credentialsFence);
}

export async function executeClaimedAction(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  scanId: string,
  claimAt: number,
  requestHash: string,
  credentials: CredentialTombstoneSnapshot,
  candidates: Candidate[] | null,
  csrfSnapshot: ActorCsrfSnapshot,
  undoWindow: number,
  overrideResult: D1Result | undefined,
  approverResult: D1Result | undefined,
): Promise<ScanEvaluation> {
  let failureCommitted = false;
  try {
    const capturedOverride = req.overrideOf ? await overrideFromResult(ctx, overrideResult) : null;
    return await attempt(
      ctx,
      actor,
      req,
      scanId,
      claimAt,
      requestHash,
      credentials,
      candidates,
      csrfSnapshot,
      undoWindow,
      capturedOverride,
      pinStaffFromResult(approverResult),
      () => {
        failureCommitted = true;
      },
    );
  } catch (cause) {
    const error = isAssetGrantAuthorityFailure(cause) ? staleScanAuthority() : cause;
    if (failureCommitted) {
      if (error instanceof ObservedScanAmbiguity) throw staleScanAuthority();
      throw error;
    }
    if (error instanceof StaleScanAuthority) {
      const original = pristineClaimFence(claimOf(ctx, actor, req, scanId, requestHash));
      await ctx.env.DB.batch([
        quarantineGateClaimStmt(ctx.env.DB, scanId, claimAt, original),
        releaseClaimStmt(ctx.env.DB, scanId, claimAt, original),
      ]);
    } else if (!(error instanceof CommittedScanUnconfirmed)) {
      const observedAmbiguous = error instanceof ObservedScanAmbiguity;
      await failScanStmt(ctx.env.DB, scanId, { at: claimAt, observedAmbiguous }).run();
      if (observedAmbiguous) throw staleScanAuthority();
    }
    throw error;
  }
}

/** The same key came again. */
export async function replayOrReopenClaim(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  hash: string,
  credentials: CredentialTombstoneSnapshot,
  csrfSnapshot: ActorCsrfSnapshot,
  undoWindow: number,
  snapshot: { row: ScanRow | null; credentialsClear: boolean },
  allowReopen = true,
): Promise<ScanEvaluation> {
  if (!credentialInputValid(req.input, credentials)) return unknownOutcome(credentials);
  const row = snapshot.row;
  if (!snapshot.credentialsClear) return unknownOutcome(credentials);
  if (!row) return unknownOutcome(credentials);
  const now = ctx.clock.now();
  const mismatch = row.requestHash !== hash;
  const inProgress =
    row.reason !== 'stale' && row.state === 'pending' && now - row.at < SCAN_IN_PROGRESS_MS;
  if (mismatch || inProgress) {
    if (allowReopen) {
      const guard = actionClaimAuthority(actor, req, credentials, csrfSnapshot, now, false);
      const current = guard
        ? await claimOutputPredicateStmt(
            ctx.env.DB,
            observedClaimCollisionPredicate(guard, row, actor.actorKey, req.idempotencyKey),
          ).first<{ authorized: number }>()
        : null;
      if (current?.authorized !== 1) return unknownOutcome(credentials);
    }
    if (mismatch)
      throw new ValidationError(
        'That key was used for a different scan.',
        [],
        'IDEMPOTENCY_KEY_REUSED',
      );
    throw new AppError('SCAN_IN_PROGRESS', 409, 'This scan is still being recorded. Try again.', {
      headers: { 'retry-after': '1' },
    });
  }
  if (row.reason === 'stale' || (row.state === 'failed' && row.reason !== null))
    return unknownOutcome(credentials);
  if (row.state === 'done') return replayOutcome(ctx, actor, req, row, credentials, csrfSnapshot);
  if (!allowReopen) return unknownOutcome(credentials);
  if (row.state === 'failed' || row.state === 'pending') {
    const claimBase = claimOf(ctx, actor, req, row.id, hash);
    const plan = await planCandidateReads(
      ctx,
      actor,
      req.input,
      credentials,
      (now) => {
        const guard = actionClaimAuthority(actor, req, credentials, csrfSnapshot, now, false);
        return guard && { sql: '1', params: [] };
      },
      true,
    );
    const claim = { ...claimBase, now: plan.now };
    const claimAt = Math.max(row.at + 1, plan.now);
    if (!Number.isSafeInteger(claimAt)) throw staleScanAuthority();
    const overrideQuery = overrideEvidenceStmt(ctx, actor, req);
    // One grant: the actor is who the guard saw, and only a pristine generation reopens.
    const g = claimGrant(ctx, actor, claim);
    const reopened = reopenOnGrant(g, claim, row.at, claimAt, row.state);
    if (row.state === 'failed') quarantineOnGrant(g, claim, row.at);
    keysetOnGrant(g, ctx.env.DB, credentials.credentialKeysetCommitment);
    const done = await g.commitWith([
      ...plan.stmts,
      ...(plan.capacityStmt ? [plan.capacityStmt] : []),
      ...(overrideQuery ? [overrideQuery] : []),
      ...(req.approval ? [staffStatement(ctx.env.DB, actor.orgId, req.approval.staffId)] : []),
    ]);
    const results = done.after;
    const reopenedAt = (done.writes[g.indexOf(reopened)]?.results?.[0] as { at?: unknown })?.at;
    if (reopenedAt !== claimAt) {
      // The grant held, so the actor is authorized: a pending generation with effects is recovered.
      if (row.state === 'pending') await recoverScans(ctx, [row]);
      return unknownOutcome(credentials);
    }
    const reread = plan.finish(results.slice(0, plan.stmts.length));
    if (plan.capacityStmt) rememberHistoryCapacities(reread, results[plan.stmts.length]);
    const overrideIndex = plan.stmts.length + (plan.capacityStmt ? 1 : 0);
    return executeClaimedAction(
      ctx,
      actor,
      req,
      row.id,
      claimAt,
      hash,
      credentials,
      reread,
      csrfSnapshot,
      undoWindow,
      overrideQuery ? results[overrideIndex] : undefined,
      req.approval ? results[overrideIndex + (overrideQuery ? 1 : 0)] : undefined,
    );
  }
  return unknownOutcome(credentials);
}
