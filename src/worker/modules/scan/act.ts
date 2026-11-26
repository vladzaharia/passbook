import {
  AppError,
  ConflictError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import {
  type ActRequest,
  type ActRequestInput,
  claimOf,
  rememberHistoryCapacities,
  requestHashOf,
} from './act-claim.ts';
import {
  claimGrant,
  claimOnGrant,
  keysetOnGrant,
  sunSeenOnGrant,
  tagSeenOnGrant,
} from './act-claim-grant.ts';
import {
  executeClaimedAction,
  replayOrReopenClaim,
  staleScanAuthority,
} from './act-claim-lifecycle.ts';
import { overrideEvidenceStmt, StaleScanAuthority } from './act-override.ts';
import { passRaced, ScanAttemptRaced, staleActorRefusal } from './act-stale-refusal.ts';
import { recordTagStop } from './act-tag-stop.ts';
import { narrowForCandidates } from './admits.ts';
import {
  type CredentialTombstoneSnapshot,
  captureCredentialTombstoneSnapshot,
  credentialInputValid,
  credentialTombstoneRefsForInput,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { refuseKeyApproval } from './guard-api-key.ts';
import { notAcceptedOutcome, unknownOutcome } from './outcome.ts';
import { isOverrideOnceViolation } from './override-scope.ts';
import { replayScanByKeyStmt, replayScanFromResult } from './repo-act-authority.ts';
import { credentialTombstonesClearStmt } from './repo-credential-tombstones.ts';
import { scanAuthorizedStmt, scanReadAuthority } from './repo-read-authority.ts';
import { approverForRequest } from './repo-staff.ts';
import { findCandidates, planCandidateReads } from './resolve-candidates.ts';
import { afterReads, capturingContext } from './scan-capture.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { type TagAct, tagRefusal } from './tag-scan.ts';

/**
 * `POST /actions` (SA 8.4): claim the key, evaluate, decide, gate, finalize, answer. A tag read brings
 * its reads to the first batch and acts on the pass they choose (design §4.3).
 */
export async function act(
  ctx: ServiceContext,
  actor: ScanActor,
  request: ActRequestInput,
  tag?: TagAct,
): Promise<ScanEvaluation> {
  ctx = capturingContext(ctx);
  refuseKeyApproval(actor, request);
  if (request.approval && !request.approval.staffId && actor.settings.staffSignIn)
    throw new ValidationError('Choose the manager.', [], 'PIN_MANAGER_REQUIRED');
  // `alone` is the signed-in requester's own approval: naming anyone else checks no one's PIN.
  if (
    request.approval?.alone &&
    request.approval.staffId !== undefined &&
    request.approval.staffId !== (actor.staff?.id ?? null)
  )
    throw new ValidationError(
      'Approve your own request with your own staff id.',
      [],
      'PIN_ALONE_NOT_SELF',
    );
  let credentials: CredentialTombstoneSnapshot | null = null;
  try {
    const [hash, derived] = await Promise.all([
      requestHashOf(request, tag?.ref),
      credentialTombstoneRefsForInput(ctx, actor.orgId, actor.mode, request.input, true, 'defer'),
    ]);
    const captured = captureCredentialTombstoneSnapshot(derived);
    credentials = captured;
    // A device with no role or an invalid scope accepts nothing; the rest of the actor is read now.
    if (actor.role === null || actor.invalidScannerScope) throw staleScanAuthority();
    const authority = scanReadAuthority(actor, { now: ctx.clock.now() });
    const initial = await ctx.env.DB.batch<{ authorized?: unknown }>([
      replayScanByKeyStmt(ctx.env.DB, actor.actorKey, request.idempotencyKey),
      platformSettingsStmt(ctx.env.DB),
      scanAuthorizedStmt(ctx.env.DB, authority),
      credentialTombstonesClearStmt(
        ctx.env.DB,
        actor.orgId,
        actor.mode,
        captured.credentialTombstoneRefs,
        captured.credentialKeysetCommitment,
      ),
      ...(tag?.stmts ?? []),
    ]);
    if (!initial[1] || initial[2]?.results?.[0]?.authorized !== 1) throw staleScanAuthority();
    let req: ActRequest;
    // The actor as the guard saw it: a tag refusal is recorded without the tag the read chose.
    const unchosen = actor;
    if ('tag' in request.input) {
      if (!tag) throw staleScanAuthority();
      // A finished scan replays with its stored pass (none for a refused tag), whatever the tag reads
      // now. A claim that did not finish is retried on the pass the tag chooses now.
      const replayed = replayScanFromResult(initial[0]);
      const chosen =
        replayed?.state === 'done'
          ? { actor, input: { passId: replayed.passId ?? '', method: 'nfc' as const } }
          : await tag.choose(initial.slice(4));
      if (!('input' in chosen))
        return replayed
          ? unknownOutcome(captured)
          : await recordTagStop(ctx, actor, request, hash, captured, chosen);
      actor = chosen.actor;
      req = { ...request, input: chosen.input };
    } else req = { ...request, input: request.input };
    const undoWindow = decodePlatformSettings(initial[1])['scan.undoWindowMinutes'];
    actor = { ...actor, credentialKeysetCommitment: captured.credentialKeysetCommitment };
    if (!credentialInputValid(req.input, captured)) return unknownOutcome(captured);
    // A mixed scope claims, replays and admits under the one entry that admits the pass.
    if (actor.events) {
      const found = await findCandidates(ctx, actor, req.input, captured);
      actor = narrowForCandidates(actor, found, ctx.clock.now());
    }
    const previous = replayScanFromResult(initial[0]);
    if (previous)
      return await replayOrReopenClaim(ctx, actor, req, hash, captured, undoWindow, {
        row: previous,
        credentialsClear: !!initial[3]?.results?.length,
      });
    const scanId = ctx.ids.ordered();
    const claimBase = claimOf(ctx, actor, req, scanId, hash);
    const plan = await planCandidateReads(
      ctx,
      actor,
      req.input,
      captured,
      () => ({ sql: '1', params: [] }),
      true,
    );
    const claim = {
      ...claimBase,
      now: plan.now,
      ...(actor.tag?.sun ? { sun: actor.tag.sun } : {}),
    };
    const overrideQuery = overrideEvidenceStmt(ctx, actor, req);
    const g = claimGrant(ctx, actor, claim);
    const claimed = claimOnGrant(g, claim);
    tagSeenOnGrant(g, claim);
    sunSeenOnGrant(g, claim);
    keysetOnGrant(g, ctx.env.DB, captured.credentialKeysetCommitment);
    // One round trip: the grant claims the key, and the reads that follow see that claim.
    const tagId = actor.tag?.sun ? actor.tag.tagId : null;
    let done: Awaited<ReturnType<typeof g.commitWith>>;
    try {
      done = await g.commitWith(
        afterReads([
          ...plan.stmts,
          ...(plan.capacityStmt ? [plan.capacityStmt] : []),
          ...(overrideQuery ? [overrideQuery] : []),
          ...(req.approval
            ? [
                approverForRequest(
                  ctx.env.DB,
                  actor.orgId,
                  req.approval,
                  actor.settings.approvals === 'desk',
                ),
              ]
            : []),
          replayScanByKeyStmt(ctx.env.DB, actor.actorKey, req.idempotencyKey),
          credentialTombstonesClearStmt(
            ctx.env.DB,
            actor.orgId,
            actor.mode,
            captured.credentialTombstoneRefs,
            captured.credentialKeysetCommitment,
          ),
        ]),
      );
    } catch (error) {
      // A read used in between: recorded against the tag, like a sequential replay, without using anything up.
      if (tagId && error instanceof AppError && error.code === 'TAG_SUN_REPLAY') {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_SUN_REPLAY' });
        return await recordTagStop(ctx, unchosen, request, hash, captured, {
          reason: 'tag_invalid',
          tagId,
          miss: false,
        });
      }
      throw error;
    }
    const results = done.after;
    const candidates = plan.finish(results.slice(0, plan.stmts.length));
    if (plan.capacityStmt) rememberHistoryCapacities(candidates, results[plan.stmts.length]);
    const overrideIndex = plan.stmts.length + (plan.capacityStmt ? 1 : 0);
    const collisionIndex = overrideIndex + (overrideQuery ? 1 : 0) + (req.approval ? 1 : 0);
    const acquired = (done.writes[g.indexOf(claimed)]?.results ?? [])[0] as
      | { id?: unknown; at?: unknown }
      | undefined;
    if (!acquired) {
      return await replayOrReopenClaim(ctx, actor, req, hash, captured, undoWindow, {
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
    // A SUN read used in between: the claim's counter check refused it, so no scan was opened.
    if (error instanceof AppError && error.code === 'TAG_SUN_REPLAY') {
      ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_SUN_REPLAY' });
      return {
        outcome: tagRefusal('tag_invalid'),
        evaluatedSnapshot: null,
        credentialContext: credentials,
      };
    }
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
    // Another override holds this heads-up (pending or won): `scans_override_once` at the claim.
    if (isOverrideOnceViolation(error))
      throw new ConflictError('Someone else already let them in.', 'SCAN_OVERRIDE_TAKEN');
    throw await scannerRefusal(ctx, actor, error);
  }
}
