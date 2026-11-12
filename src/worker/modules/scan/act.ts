import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import { type ActRequest, claimOf, rememberHistoryCapacities, requestHashOf } from './act-claim.ts';
import { claimGrant, claimOnGrant, keysetOnGrant } from './act-claim-grant.ts';
import {
  actionClaimAuthority,
  executeClaimedAction,
  replayOrReopenClaim,
  staleScanAuthority,
} from './act-claim-lifecycle.ts';
import { overrideEvidenceStmt, StaleScanAuthority } from './act-override.ts';
import { snapshotActionContext } from './act-snapshot.ts';
import { passRaced, ScanAttemptRaced, staleActorRefusal } from './act-stale-refusal.ts';
import { actorCsrfAuthorityStmt, actorCsrfSnapshotFromResult } from './actor-csrf.ts';
import {
  type CredentialTombstoneSnapshot,
  captureCredentialTombstoneSnapshot,
  credentialInputValid,
  credentialTombstoneRefsForInput,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { notAcceptedOutcome, unknownOutcome } from './outcome.ts';
import { candidateInitializationFence } from './repo-act.ts';
import { replayScanByKeyStmt, replayScanFromResult } from './repo-act-authority.ts';
import { actorAuthorityPredicates } from './repo-actor-authority.ts';
import { credentialTombstonesClearStmt } from './repo-credential-tombstones.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import { pristineClaimFence } from './repo-scans.ts';
import { staffStatement } from './repo-staff.ts';
import { planCandidateReads } from './resolve-candidates.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** `POST /actions` (SA 8.4): claim the key, evaluate, decide, gate, finalize, answer. */
export async function act(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
): Promise<ScanEvaluation> {
  ctx = snapshotActionContext(ctx);
  actor = cloneObservedScanActor(actor);
  const { input, approval, ...request } = req;
  req = {
    ...structuredClone(request),
    input: { ...input },
    ...(approval ? { approval: { ...approval } } : {}),
  };
  let credentials: CredentialTombstoneSnapshot | null = null;
  try {
    const [hash, derived] = await Promise.all([
      requestHashOf(req),
      credentialTombstoneRefsForInput(ctx, actor.orgId, actor.mode, req.input, true, 'defer'),
    ]);
    const captured = captureCredentialTombstoneSnapshot(derived);
    credentials = captured;
    const csrfQuery = actorCsrfAuthorityStmt(ctx.env.DB, actor);
    if (!csrfQuery) throw staleScanAuthority();
    const actorFences = actorAuthorityPredicates({
      actor,
      now: ctx.clock.now(),
      event: actor.event,
      adminEventTemplates: actor.principal === 'admin' && !req.scope?.templateIds?.length,
    });
    const initial = await ctx.env.DB.batch<{ authorized?: unknown }>([
      replayScanByKeyStmt(ctx.env.DB, actor.actorKey, req.idempotencyKey),
      platformSettingsStmt(ctx.env.DB),
      csrfQuery,
      credentialTombstonesClearStmt(
        ctx.env.DB,
        actor.orgId,
        actor.mode,
        captured.credentialTombstoneRefs,
        captured.credentialKeysetCommitment,
      ),
      ...actorFences.map((fence) => outputPredicateStmt(ctx.env.DB, fence)),
    ]);
    const csrfSnapshot = await actorCsrfSnapshotFromResult(ctx, actor, initial[2]);
    if (
      !csrfSnapshot ||
      !initial[1] ||
      actorFences.some((_, index) => initial[index + 4]?.results?.[0]?.authorized !== 1)
    )
      throw staleScanAuthority();
    const undoWindow = decodePlatformSettings(initial[1])['scan.undoWindowMinutes'];
    actor.credentialKeysetCommitment = captured.credentialKeysetCommitment;
    if (!credentialInputValid(req.input, captured)) return unknownOutcome(captured);
    const previous = replayScanFromResult(initial[0]);
    if (previous)
      return await replayOrReopenClaim(ctx, actor, req, hash, captured, csrfSnapshot, undoWindow, {
        row: previous,
        credentialsClear: !!initial[3]?.results?.length,
      });
    const scanId = ctx.ids.ordered();
    const claimBase = claimOf(ctx, actor, req, scanId, hash);
    const pristine = pristineClaimFence(claimBase);
    const plan = await planCandidateReads(
      ctx,
      actor,
      req.input,
      captured,
      (now) => {
        const guard = actionClaimAuthority(actor, req, captured, csrfSnapshot, now, true);
        return (
          guard && candidateInitializationFence(actor.actorKey, req.idempotencyKey, pristine, guard)
        );
      },
      true,
    );
    const claim = { ...claimBase, now: plan.now };
    const claimGuard = actionClaimAuthority(actor, req, captured, csrfSnapshot, plan.now, true);
    if (!claimGuard) throw staleScanAuthority();
    const overrideQuery = overrideEvidenceStmt(ctx, actor, req);
    const g = claimGrant(ctx, actor, claim);
    const claimed = claimOnGrant(g, claim);
    keysetOnGrant(g, ctx.env.DB, captured.credentialKeysetCommitment);
    // One round trip: the grant claims the key, and the reads that follow see that claim.
    const done = await g.commitWith([
      ...plan.stmts,
      ...(plan.capacityStmt ? [plan.capacityStmt] : []),
      ...(overrideQuery ? [overrideQuery] : []),
      ...(req.approval ? [staffStatement(ctx.env.DB, actor.orgId, req.approval.staffId)] : []),
      replayScanByKeyStmt(ctx.env.DB, actor.actorKey, req.idempotencyKey),
      credentialTombstonesClearStmt(
        ctx.env.DB,
        actor.orgId,
        actor.mode,
        captured.credentialTombstoneRefs,
        captured.credentialKeysetCommitment,
      ),
    ]);
    const results = done.after;
    const candidates = plan.finish(results.slice(0, plan.stmts.length));
    if (plan.capacityStmt) rememberHistoryCapacities(candidates, results[plan.stmts.length]);
    const overrideIndex = plan.stmts.length + (plan.capacityStmt ? 1 : 0);
    const collisionIndex = overrideIndex + (overrideQuery ? 1 : 0) + (req.approval ? 1 : 0);
    const acquired = (done.writes[g.indexOf(claimed)]?.results ?? [])[0] as
      | { id?: unknown; at?: unknown }
      | undefined;
    if (!acquired) {
      return await replayOrReopenClaim(ctx, actor, req, hash, captured, csrfSnapshot, undoWindow, {
        row: replayScanFromResult(results[collisionIndex]),
        credentialsClear: !!results[collisionIndex + 1]?.results?.length,
      });
    }
    if (
      typeof acquired.id !== 'string' ||
      typeof acquired.at !== 'number' ||
      !Number.isSafeInteger(acquired.at)
    )
      throw staleScanAuthority();
    return await executeClaimedAction(
      ctx,
      actor,
      req,
      acquired.id,
      acquired.at,
      hash,
      captured,
      candidates,
      csrfSnapshot,
      undoWindow,
      overrideQuery ? results[overrideIndex] : undefined,
      req.approval ? results[overrideIndex + (overrideQuery ? 1 : 0)] : undefined,
    );
  } catch (error) {
    // A scanner whose scope accepts nothing (an invalid or empty event-bound session) is told so.
    const accepts =
      actor.principal !== 'scanner' ||
      actor.templateIds.length > 0 ||
      actor.settings.acceptAllTemplates;
    // Authority lost mid-request is the actor's drift (401 only for a lost credential). A claimed
    // attempt that raced the pass is retried with the same key; a replay or claim that cannot be
    // proven stays masked.
    if (error instanceof StaleScanAuthority) {
      const raced = error instanceof ScanAttemptRaced;
      const refusal = await staleActorRefusal(ctx, actor, raced);
      if (refusal) throw refusal;
      if (!accepts) return notAcceptedOutcome(credentials);
      if (raced) throw passRaced();
      return unknownOutcome(credentials);
    }
    if (error instanceof UnavailableError && error.code === 'CREDENTIAL_REF_KEYSET_UNAVAILABLE')
      return accepts ? unknownOutcome(credentials) : notAcceptedOutcome(credentials);
    throw await scannerRefusal(ctx, actor, error);
  }
}
