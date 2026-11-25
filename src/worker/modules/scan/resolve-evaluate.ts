import type { ScanCodeInput } from '../../../shared/contracts/scan.ts';
import { TYPED_NUMBER_FLAG } from '../../../shared/copy/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { paperOff, printRefusal } from '../prints/door.ts';
import { accessStop, joinReads, planAccessReads } from './access.ts';
import { passRulesOf, planAdmission } from './admission.ts';
import {
  type CredentialTombstoneSnapshot,
  captureCredentialTombstoneSnapshot,
  credentialInputValid,
  credentialTombstoneRefsForInput,
  snapshotCredentialEnv,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { occupancyAsRead, planOccupancy } from './occupancy/admission.ts';
import { credentialTombstonesClear } from './repo-credential-tombstones.ts';
import { type Candidate, hasScanPolicy } from './repo-lookup.ts';
import { codeRotatedOut } from './repo-rotations.ts';
import { activeFlags, type Evaluated, type Found, foundOf } from './resolve.ts';
import {
  accepts,
  candidateAudit,
  candidateCredentialSnapshotValid,
  candidateWallet,
  eventAcceptsPass,
  findCandidates,
  matchesEvent,
} from './resolve-candidates.ts';
import { channelVerdict } from './resolve-channels.ts';
import { exitGate, mayExit, suspendedOf, unavailable } from './resolve-exit.ts';
import { stop, type Waive, windowStop } from './resolve-policy.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { candidateTakesTag, levelAllows } from './tag-assurance.ts';
import { tagCheck, tagTypeHolds } from './tag-confirm.ts';

/** Additional request-local reads sharing the admission snapshot transaction. */
export interface EvaluationReadPlan {
  stmts: D1PreparedStatement[];
  finish(results: readonly D1Result[]): Promise<void>;
}

export interface EvaluationOptions {
  candidateRead?: { candidates: Candidate[] | null };
  prepareReads?: (found: Found) => Promise<EvaluationReadPlan | undefined>;
  /** False when the request runs a value action: admission, presence and capacity are a check-in's. */
  admits?: (found: Found) => boolean;
  /** OC4: true only when the caller will commit a tap-out of this Found (an act with a concrete check-in action). */
  commitsExit?: (found: Found) => boolean;
}

/** SA 2.6 steps 5-13. A found pass that passes every step comes back as `found`. */
export async function evaluate(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanCodeInput,
  waive: Waive = {},
  observed?: CredentialTombstoneSnapshot,
  options: EvaluationOptions = {},
): Promise<Evaluated> {
  actor = cloneObservedScanActor(actor);
  input = { ...input };
  waive = { ...waive };
  if (observed) observed = captureCredentialTombstoneSnapshot(observed);
  const originalEnv = ctx.env;
  const pinnedEnv = snapshotCredentialEnv(originalEnv);
  overrideDeps(pinnedEnv, depsOf(originalEnv));
  ctx = { ...ctx, env: pinnedEnv };
  const source =
    observed ?? (await credentialTombstoneRefsForInput(ctx, actor.orgId, actor.mode, input));
  const refs = {
    credentialKeysetCommitment: source.credentialKeysetCommitment,
    credentialTombstoneRefs: source.credentialTombstoneRefs,
    otherModeCredentialTombstoneRefs: source.otherModeCredentialTombstoneRefs,
  };
  if (!credentialInputValid(input, refs))
    return { ...stop('refused', 'not_found', { stale: true }), ...refs };
  const result = await evaluateObserved(ctx, actor, input, waive, refs, options);
  return result.stop ? Object.assign(result, refs) : result;
}

async function evaluateObserved(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanCodeInput,
  waive: Waive,
  refs: CredentialTombstoneSnapshot,
  options: EvaluationOptions,
): Promise<Evaluated> {
  // Fail closed first: an empty or invalid scope accepts nothing, whatever the code names.
  if (
    actor.principal === 'scanner' &&
    !actor.overrideScope &&
    actor.templateIds.length === 0 &&
    !actor.settings.acceptAllTemplates
  )
    return stop('refused', 'not_accepted');
  const all =
    options.candidateRead === undefined
      ? await findCandidates(ctx, actor, input, refs)
      : options.candidateRead.candidates;
  if (!all) return stop('refused', 'not_found', { stale: true });
  const sameRefs = (left: readonly string[], right: readonly string[]) =>
    Array.isArray(left) && left.length === right.length && left.every((ref, i) => ref === right[i]);
  if (
    all.some(
      (candidate) =>
        candidate.pass.orgId !== actor.orgId ||
        ('passId' in input && candidate.pass.id !== input.passId) ||
        candidate.credentialKeysetCommitment !== refs.credentialKeysetCommitment ||
        !sameRefs(candidate.credentialTombstoneRefs, refs.credentialTombstoneRefs) ||
        !sameRefs(
          candidate.otherModeCredentialTombstoneRefs,
          refs.otherModeCredentialTombstoneRefs,
        ),
    )
  )
    return stop('refused', 'not_found', { stale: true });
  const first = all[0];
  if (!first)
    return 'passId' in input ||
      !(await codeRotatedOut(ctx.env.DB, actor.orgId, actor.mode, refs.credentialTombstoneRefs))
      ? stop('refused', 'not_found')
      : stop('refused', 'code_replaced');
  if (all.some((candidate) => !candidateCredentialSnapshotValid(candidate)))
    return stop('refused', 'not_found', { stale: true });
  const inMode = all.filter((candidate) => candidate.pass.mode === actor.mode);
  if (inMode.length === 0) {
    const otherMode = actor.mode === 'live' ? 'test' : 'live';
    if (
      !(await credentialTombstonesClear(
        ctx.env.DB,
        actor.orgId,
        otherMode,
        refs.otherModeCredentialTombstoneRefs,
        refs.credentialKeysetCommitment,
      ))
    )
      return stop('refused', 'not_found', { stale: true });
    return stop('refused', actor.mode === 'live' ? 'test_pass' : 'live_pass');
  }
  const accepted = inMode.filter((candidate) => accepts(actor, candidate.pass));
  if (accepted.length === 0) return stop('refused', 'not_accepted');
  const matched = accepted.filter((candidate) => matchesEvent(actor, candidate.pass));
  const one = matched[0];
  if (!one) return stop('refused', 'wrong_event');
  if (matched.length > 1) return stop('refused', 'ambiguous');
  // A mixed scope is narrowed to the admitting entry before evaluation (`admits.ts`): never admit through it.
  if (actor.events) return stop('refused', 'not_found', { stale: true });
  // How the code matched is the door's, not part of the stored snapshot's.
  const matchedBy = one.matchedBy;
  delete one.matchedBy;
  // The release read at commit may differ from the one the tag was chosen on.
  if (
    actor.tag &&
    !(
      candidateTakesTag(ctx, one, actor.tag.assurance) &&
      levelAllows(actor.settings.tags?.level, actor.tag.assurance) &&
      tagTypeHolds(actor, one)
    )
  )
    return stop('refused', 'tag_not_allowed');
  if (one.orgRevision == null || one.templateRevision == null || !hasScanPolicy(one))
    return stop('refused', 'not_found', { stale: true });
  const printed = printRefusal(one);
  if (printed)
    return candidateWallet(one)
      ? stop('refused', printed.reason, { ...candidateAudit(one), at: printed.at })
      : stop('refused', 'not_found', { stale: true });
  // The pass's own refusal (a void) comes before the paper channel's.
  if (one.pass.status === 'active' && (await paperOff(ctx, one)))
    return candidateWallet(one)
      ? stop('refused', 'channel_off', {
          ...candidateAudit(one),
          at: null,
          channel: 'paper',
        })
      : stop('refused', 'not_found', { stale: true });
  const found = await foundOf(ctx, one, actor, { exit: mayExit(actor, one) });
  if (!found) return unavailable(ctx, one);
  const known = {
    pass: found.pass,
    ref: found.ref,
    found,
    connectionGeneration: found.connectionGeneration,
  };
  const channel = await channelVerdict(ctx, one, input, matchedBy);
  if (channel?.kind === 'off' && !found.inactive)
    return stop('refused', 'channel_off', { ...candidateAudit(one), channel: channel.channel });
  const configured =
    options.admits?.(found) !== false &&
    (Object.keys(passRulesOf(found)).length > 0 ||
      Object.keys(actor.settings.checkIn ?? {}).length > 0 ||
      actor.settings.direction === 'out' ||
      actor.settings.direction === 'both');
  const prepared = await options.prepareReads?.(found);
  // An Access card's zones ride the same read as the pass fence: no trip of their own on an action.
  const accessReads = planAccessReads(ctx, actor, found);
  const extraReads = joinReads(prepared, accessReads);
  // Action callers also capture event-scoped admission in the same transaction.
  const eventAdmission =
    !configured &&
    options.admits?.(found) !== false &&
    actor.event != null &&
    prepared !== undefined;
  if (!configured && !eventAdmission && extraReads) {
    const results = extraReads.stmts.length ? await ctx.env.DB.batch(extraReads.stmts) : [];
    await extraReads.finish(results);
  }
  const planned =
    configured || eventAdmission
      ? await planAdmission(
          ctx,
          actor,
          found,
          waive.override ? 'in' : configured ? waive.direction : 'in',
          extraReads,
        )
      : null;
  const now = ctx.clock.now();
  // An Access card at a door with a tracked zone counts there (SA §20.3): that replaces admission.
  const loaded =
    prepared !== undefined && options.admits?.(found) !== false && accessReads?.loaded();
  const placed = loaded
    ? planOccupancy({
        ...loaded.occupancy,
        zoneIds: loaded.zoneIds,
        orgTimeZone: loaded.orgTimeZone,
        setting: actor.settings.direction,
        requested: waive.override ? 'in' : waive.direction,
        now,
      })
    : null;
  // A re-entry event is a place too: its admission rules still apply, the builder decides in and out.
  const eventPlaced = !placed ? (planned?.place ?? null) : null;
  const admission = configured && !placed ? planned : null;
  const place = placed ?? eventPlaced;
  const zoneExit = place?.found.direction === 'out';
  const exiting = admission?.plan.state.direction === 'out' || zoneExit;
  if (found.inactive) {
    const inside = place?.found.inside ?? admission?.plan.state.inside ?? false;
    const gated = exitGate(ctx, one, {
      exiting,
      inside,
      commits: options.commitsExit?.(found) === true,
      channel,
    });
    if (gated) return gated;
  } else if (exiting && suspendedOf(ctx, actor, found, known, accessReads, now))
    found.suspended = true;
  // The pass's own event filter rejects it: a bare refusal, with no card, identity or grant.
  const selected = admission?.plan.event;
  if (selected && !eventAcceptsPass(actor, selected, found.pass))
    return stop('refused', 'wrong_event');
  found.admission = admission?.plan;
  if (place) found.occupancy = place.found;
  if (eventAdmission && planned) {
    found.eventAdmission = planned.plan;
    found.eventAdmissionReason = planned.reason;
  }
  // Step 9a: an Auto flip under two minutes old is held, with the flip offered (not overridable).
  if (place?.turnaround)
    return stop('heads_up', place.found.inside ? 'still_inside' : 'not_inside', {
      ...known,
      at: place.found.row?.changed_at ?? null,
      hard: true,
      occupancy: occupancyAsRead(place.found, place.turnaround),
    });
  // Access refusals are authority: they come before the gate, the window and every heads-up.
  const denied = exiting
    ? null
    : accessStop(ctx, actor, found, known, accessReads, now, waive.access);
  if (denied) return denied;
  if (admission?.reason)
    return stop(
      admission.reason === 'not_accepted' || admission.reason === 'wrong_event'
        ? 'refused'
        : 'heads_up',
      admission.reason,
      { ...known, at: admission.at, flags: admission.flags, hard: true },
    );
  // An Access card has its own window (the plan and the pass's start and end): AX 3.4 skips 11-12.
  const held = exiting || found.access ? null : windowStop(actor, found, now, waive);
  if (held) return held;
  // A tag that asks for a second factor: a Manager's PIN stops the tap alone, a staff check joins the flags.
  const tagged = exiting ? null : tagCheck(actor, waive);
  if (tagged?.kind === 'manager')
    return stop('heads_up', 'needs_approval', { ...known, at: null, flags: [tagged.flag] });
  const flagged = activeFlags(found).filter((flag) => flag.stop);
  const typed = channel?.kind === 'typed';
  if (tagged || ((flagged.length > 0 || typed) && !waive.confirmed && !zoneExit && !found.inactive))
    return stop('heads_up', 'check_required', {
      ...known,
      flags: [
        ...(tagged ? [tagged.flag] : []),
        ...(typed ? [TYPED_NUMBER_FLAG] : []),
        ...activeFlags(found, actor)
          .filter((flag) => flag.stop)
          .map((flag) => flag.label),
      ],
    });
  return { stop: false, found };
}
