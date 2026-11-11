import type { ScanInput } from '../../../shared/contracts/scan.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { planAdmission } from './admission.ts';
import {
  type CredentialTombstoneSnapshot,
  captureCredentialTombstoneSnapshot,
  credentialInputValid,
  credentialTombstoneRefsForInput,
  snapshotCredentialEnv,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { credentialTombstonesClear } from './repo-credential-tombstones.ts';
import { type Candidate, hasScanPolicy } from './repo-lookup.ts';
import { activeFlags, type Evaluated, type Found, foundOf } from './resolve.ts';
import {
  accepts,
  candidateAudit,
  candidateCredentialSnapshotValid,
  candidateWallet,
  findCandidates,
  eventAcceptsPass,
  matchesEvent,
} from './resolve-candidates.ts';
import { stop, type Waive, windowStop } from './resolve-policy.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** Additional request-local reads sharing the admission snapshot transaction. */
export interface EvaluationReadPlan {
  stmts: D1PreparedStatement[];
  finish(results: readonly D1Result[]): Promise<void>;
}

export interface EvaluationOptions {
  candidateRead?: { candidates: Candidate[] | null };
  prepareReads?: (found: Found) => Promise<EvaluationReadPlan>;
}

/** SA 2.6 steps 5-13. A found pass that passes every step comes back as `found`. */
export async function evaluate(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanInput,
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
  input: ScanInput,
  waive: Waive,
  refs: CredentialTombstoneSnapshot,
  options: EvaluationOptions,
): Promise<Evaluated> {
  // Fail closed first: an empty or invalid scope accepts nothing, whatever the code names.
  if (
    actor.principal === 'scanner' &&
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
  if (!first) return stop('refused', 'not_found');
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
  if (one.orgRevision == null || one.templateRevision == null || !hasScanPolicy(one))
    return stop('refused', 'not_found', { stale: true });
  const found = await foundOf(ctx, one, actor);
  if (!found) {
    const json = candidateWallet(one);
    if (!json) return stop('refused', 'not_found', { stale: true });
    const audit = candidateAudit(one);
    if (one.pass.removedAt !== null)
      return stop('refused', 'removed', { ...audit, at: one.pass.removedAt });
    if (one.pass.status === 'voided')
      return stop('refused', 'voided', { ...audit, at: one.pass.modifiedAt });
    const validity = validityOf(json, ctx.clock.now());
    if (validity.status === 'voided')
      return stop('refused', 'voided', { ...audit, at: one.pass.modifiedAt });
    if (validity.status === 'expired')
      return stop('refused', 'expired', { ...audit, at: validity.validUntil });
    return stop('refused', 'not_accepted');
  }
  const known = {
    pass: found.pass,
    ref: found.ref,
    found,
    connectionGeneration: found.connectionGeneration,
  };
  const configured =
    Object.keys(found.checkInRules ?? {}).length > 0 ||
    Object.keys(actor.settings.checkIn ?? {}).length > 0 ||
    actor.settings.direction === 'out' ||
    actor.settings.direction === 'both';
  const extraReads = await options.prepareReads?.(found);
  // Action callers also capture event-scoped admission in the same transaction.
  const eventAdmission = !configured && actor.event != null && extraReads !== undefined;
  if (!configured && !eventAdmission && extraReads) {
    const results = extraReads.stmts.length ? await ctx.env.DB.batch(extraReads.stmts) : [];
    await extraReads.finish(results);
  }
  const planned =
    configured || eventAdmission
      ? await planAdmission(ctx, actor, found, configured ? waive.direction : 'in', extraReads)
      : null;
  const admission = configured ? planned : null;
  // The pass's own event filter rejects it: a bare refusal, with no card, identity or grant.
  const selected = admission?.plan.event;
  if (selected && !eventAcceptsPass(actor, selected, found.pass))
    return stop('refused', 'wrong_event');
  found.admission = admission?.plan;
  if (eventAdmission && planned) {
    found.eventAdmission = planned.plan;
    found.eventAdmissionReason = planned.reason;
  }
  const exiting = admission?.plan.state.direction === 'out';
  const now = ctx.clock.now();
  if (admission?.reason)
    return stop(
      admission.reason === 'not_accepted' || admission.reason === 'wrong_event'
        ? 'refused'
        : 'heads_up',
      admission.reason,
      { ...known, at: admission.at, flags: admission.flags, hard: true },
    );
  const held = exiting ? null : windowStop(actor, found, now, waive);
  if (held) return held;
  const flagged = activeFlags(found).filter((flag) => flag.stop);
  if (flagged.length > 0 && !waive.confirmed)
    return stop('heads_up', 'check_required', {
      ...known,
      flags: activeFlags(found, actor)
        .filter((flag) => flag.stop)
        .map((flag) => flag.label),
    });
  return { stop: false, found };
}
