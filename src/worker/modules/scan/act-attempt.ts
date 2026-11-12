import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { executeApprovedAction } from './act-approval.ts';
import { stoppedAuditPass } from './act-attempt-audit.ts';
import { chooseAction } from './act-choose.ts';
import { type ActRequest, claimOf } from './act-claim.ts';
import {
  checkOverride,
  invalid,
  type Override,
  pickAction,
  StaleScanAuthority,
} from './act-override.ts';
import { planActionReads } from './act-read-plan.ts';
import { ScanAttemptRaced } from './act-stale-refusal.ts';
import { finishStop, type StopContext } from './act-stop.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { photoGrantPurpose } from './asset-types.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { knownPhotoUrl, type PreparedPhotoGrant } from './member-photo.ts';
import { unknownOutcome } from './outcome.ts';
import { invalidAttemptAuthority } from './repo-act-attempt-authority.ts';
import { scanTemplateSnapshotPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import { passSnapshotFence } from './repo-pass-authority.ts';
import type { Found, Stop } from './resolve.ts';
import { evaluate } from './resolve-evaluate.ts';
import { defaultAction } from './resolve-outcome.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import type { PinStaffSnapshot } from './staff-pin.ts';

const WINDOW_REASONS: Partial<Record<ScanReason, true>> = { not_yet_valid: true, ended: true };
const stale = () => new StaleScanAuthority();
// The pass moved between evaluation and the preflight read: a race the client retries, not a miss.
const raced = () => new ScanAttemptRaced();

export async function attempt(
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
  capturedOverride: Override | null,
  approver: PinStaffSnapshot | null,
  onFailureCommitted: () => void,
): Promise<ScanEvaluation> {
  const authorityActor = actor;
  const ownedClaim = claimOf(ctx, authorityActor, req, scanId, requestHash);
  const reads = planActionReads(ctx, authorityActor, req, scanId);
  let invalidFound: Found | null = null;
  const invalidAuthority = () =>
    invalidAttemptAuthority(
      ctx,
      authorityActor,
      req,
      credentials,
      csrfSnapshot,
      ownedClaim,
      invalidFound,
    );
  const stopFor = (action: ResolvedScanAction | null): StopContext => ({
    ctx,
    actor,
    scanId,
    claimAt,
    ownedClaim,
    method: req.input.method,
    idempotencyKey: req.idempotencyKey,
    requestHash,
    credentialTombstoneRefs: credentials.credentialTombstoneRefs,
    credentialKeysetCommitment: credentials.credentialKeysetCommitment,
    csrfSnapshot,
    history: reads.preloaded,
    photo,
    otherModeCredentialTombstoneRefs: [],
    dayStart: req.dayStart,
    action,
    overrideOf: req.overrideOf ?? null,
    onFailureCommitted,
  });
  let override: Override | null = null;
  let photo: PreparedPhotoGrant | null = null;
  const evaluated = await evaluate(
    ctx,
    actor,
    req.input,
    {
      window: !!capturedOverride && !!WINDOW_REASONS[capturedOverride.reason],
      confirmed: req.confirmed === true,
      direction: req.direction,
    },
    credentials,
    { candidateRead: { candidates }, prepareReads: reads.prepare },
  );
  invalidFound = evaluated.found;
  if (evaluated.stop && evaluated.stale) throw stale();
  if (
    req.overrideOf &&
    !(evaluated.stop && (evaluated.reason === 'test_pass' || evaluated.reason === 'live_pass'))
  )
    override = await checkOverride(
      ctx,
      req,
      ownedClaim,
      claimAt,
      invalidAuthority,
      capturedOverride,
      onFailureCommitted,
    );
  if (evaluated.stop) {
    if (evaluated.found?.admission?.event) {
      actor = { ...actor, event: evaluated.found.admission.event };
    }
    if (evaluated.found) reads.bind(actor, evaluated.found);
    if (evaluated.stale) throw stale();
    if (
      evaluated.found?.liveCandidate?.hasPhoto &&
      scanTemplateSnapshotPredicate(
        evaluated.found.liveCandidate,
        evaluated.found.liveCandidate.templateSnapshot,
        photoGrantPurpose(evaluated.found.liveCandidate),
      ).sql !== '0'
    )
      photo = await knownPhotoUrl(
        ctx,
        authorityActor,
        evaluated.found.liveCandidate,
        evaluated.found.template,
        evaluated.found.activePolicy,
      );
    if (evaluated.reason === 'test_pass' || evaluated.reason === 'live_pass') {
      const generic: Stop = {
        stop: true,
        kind: 'refused',
        reason: 'not_found',
        pass: null,
        ref: null,
        at: null,
        flags: [],
        found: null,
      };
      await finishStop(
        {
          ...stopFor(null),
          overrideOf: null,
          suppressCounts: true,
          otherModeCredentialTombstoneRefs: credentials.otherModeCredentialTombstoneRefs,
        },
        generic,
        {
          actor: authorityActor,
          event: null,
          adminEventTemplates:
            authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
          passFence: null,
        },
      );
      return {
        outcome: { ...unknownOutcome(credentials).outcome, reason: evaluated.reason },
        evaluatedSnapshot: null,
        credentialContext: credentials,
      };
    }
    const auditPass = stoppedAuditPass(evaluated, credentials);
    const pass = evaluated.pass ?? auditPass;
    const policy = evaluated.auditPassSnapshot ?? evaluated;
    const scopedTemplate = evaluated.found?.pass.templateId ?? auditPass?.templateId;
    const preparedPassFence = evaluated.found
      ? (reads.plan?.current()?.passFence ?? reads.passFence)
      : null;
    if (evaluated.found && !preparedPassFence) throw raced();
    const passFence = pass
      ? (preparedPassFence ??
        (await passSnapshotFence(
          ctx.env.DB,
          pass,
          evaluated.found?.checkInRules,
          evaluated.connectionGeneration,
          evaluated.found?.activeVersion ?? policy.activeTemplateVersion ?? undefined,
          evaluated.found?.orgRevision ?? policy.orgRevision,
          evaluated.found?.templateRevision ?? policy.templateRevision,
          ctx.clock.now(),
          ctx.env,
          evaluated.found ?? policy,
        )))
      : null;
    if (pass && !passFence) throw raced();
    const named = evaluated.found?.scan.actions.find((a) => a.id === req.actionId);
    const action = named ?? (evaluated.found ? defaultAction(actor, evaluated.found.scan) : null);
    return {
      outcome: await finishStop(
        { ...stopFor(action), countMiss: evaluated.reason === 'not_found' },
        evaluated,
        {
          actor: authorityActor,
          event: evaluated.found?.admission?.event ?? null,
          ...(scopedTemplate ? { templateId: scopedTemplate } : {}),
          adminEventTemplates:
            authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
          passFence,
        },
        auditPass,
      ),
      evaluatedSnapshot: evaluated.found?.liveCandidate ?? null,
      credentialContext: credentials,
    };
  }
  const { found } = evaluated;
  if (found.admission?.event) {
    actor = { ...actor, event: found.admission.event };
  }
  if (
    found.liveCandidate?.hasPhoto &&
    scanTemplateSnapshotPredicate(
      found.liveCandidate,
      found.liveCandidate.templateSnapshot,
      photoGrantPurpose(found.liveCandidate),
    ).sql !== '0'
  )
    photo = await knownPhotoUrl(
      ctx,
      authorityActor,
      found.liveCandidate,
      found.template,
      found.activePolicy,
    );
  reads.bind(actor, found);
  const picked = pickAction(actor, found.scan, req.actionId);
  if (picked === 'choose')
    return chooseAction({
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
      photo,
      undoWindow,
      history: reads.preloaded,
      onFailureCommitted,
    });
  if (picked?.kind !== 'check_in')
    return invalid(
      ctx,
      ownedClaim,
      claimAt,
      'SCAN_ACTION_UNKNOWN',
      'Choose an action this pass offers.',
      invalidAuthority,
      onFailureCommitted,
    );
  const action = picked;
  if (
    override &&
    (!action.allowAgain ||
      override.scan.passId !== found.pass.id ||
      override.scan.actionId !== action.id)
  )
    return invalid(
      ctx,
      ownedClaim,
      claimAt,
      'SCAN_OVERRIDE_INVALID',
      'That scan cannot be let through.',
      invalidAuthority,
      onFailureCommitted,
    );

  const preflight = reads.plan?.current();
  if (!preflight) throw raced();
  return executeApprovedAction({
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
    history: reads.history,
    photo,
    undoWindow,
    approver,
    stopFor,
    onFailureCommitted,
  });
}
