import type { z } from 'zod';
import type { ScanResolveRequestSchema } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import { type CardRead, historyPlan, readCard, readyOutcome, renderCardDisplay } from './card.ts';
import type { CountsPlan } from './counts.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { knownPhotoUrl } from './member-photo.ts';
import { blankOutcome, stopOutcome } from './outcome.ts';
import type { Candidate } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import { accepts, candidateAudit, matchesEvent } from './resolve-candidates.ts';
import { evaluate } from './resolve-evaluate.ts';
import { currentFound } from './resolve-outcome-current.ts';
import {
  acceptedFilter,
  candidateEligible,
  candidateDetectionProof,
  candidateReadProof,
  currentInputActor,
  inputCandidates,
} from './resolve-passless-read.ts';
import type { FinalizedDisplayHistory } from './scan-display-history.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';

type ObservedEvaluation = Omit<ScanEvaluation, 'credentialContext'> & { unconfirmed?: true };

export function unknown(): ObservedEvaluation {
  return {
    outcome: {
      ...blankOutcome('refused', {
        approvals: false,
        counts: { today: 0, event: null, asOf: 0, configRev: 0 },
      }),
      reason: 'not_found',
    },
    unconfirmed: true,
    evaluatedSnapshot: null,
  };
}

export async function resolveObserved(
  ctx: ServiceContext,
  actor: ScanActor,
  req: z.infer<typeof ScanResolveRequestSchema>,
  credentials: CredentialTombstoneSnapshot,
  csrfSnapshot: ActorCsrfSnapshot,
  candidateRead: { candidates: Candidate[] | null },
  counts: CountsPlan,
  undoWindowMinutes: number,
  defaultAction: (actor: ScanActor, scan: ResolvedScanManifest) => ResolvedScanAction | null,
): Promise<ObservedEvaluation> {
  const evaluated = await evaluate(ctx, actor, req.input, undefined, credentials, {
    candidateRead,
  });
  if (evaluated.stop && evaluated.stale) return unknown();
  const photoFound = evaluated.found;
  const original = photoFound?.liveCandidate;
  const photoGrant =
    photoFound && original?.hasPhoto
      ? await knownPhotoUrl(ctx, actor, original, photoFound.template, photoFound.activePolicy)
      : null;
  if (!evaluated.stop) {
    let result: CardRead | null;
    try {
      result = await readCard(ctx, actor, evaluated.found, counts, 'read', undoWindowMinutes);
    } catch (error) {
      if (isNotFound(error)) return unknown();
      throw error;
    }
    if (!result) return unknown();
    const { card: draft, read, historyFence, displayHistory, passViewGrant } = result;
    const proof = await currentFound(
      ctx,
      actor,
      evaluated.found,
      displayHistory,
      csrfSnapshot,
      photoGrant,
      historyFence,
      passViewGrant,
    );
    if (!proof?.passViewToken) return unknown();
    if (!proof.cardHistoryCurrent) draft.lastScans = [];
    const card = { ...draft, passView: { ...draft.passView, assetGrant: proof.passViewToken } };
    renderCardDisplay(ctx, actor, evaluated.found, card, proof.history, proof.photoUrl);
    return {
      outcome: readyOutcome(card, read),
      evaluatedSnapshot: evaluated.found.liveCandidate ?? null,
    };
  }
  const found = evaluated.found;
  if (found && evaluated.kind === 'heads_up') {
    let result: CardRead | null;
    try {
      result = await readCard(ctx, actor, found, counts, 'read', undoWindowMinutes);
    } catch (error) {
      if (isNotFound(error)) return unknown();
      throw error;
    }
    if (!result) return unknown();
    const { card: draft, read, historyFence, displayHistory, passViewGrant } = result;
    const proof = await currentFound(
      ctx,
      actor,
      found,
      displayHistory,
      csrfSnapshot,
      photoGrant,
      historyFence,
      passViewGrant,
    );
    if (!proof?.passViewToken) return unknown();
    if (!proof.cardHistoryCurrent) draft.lastScans = [];
    const card = { ...draft, passView: { ...draft.passView, assetGrant: proof.passViewToken } };
    renderCardDisplay(ctx, actor, found, card, proof.history, proof.photoUrl);
    return {
      outcome: stopOutcome(ctx, actor, evaluated, read, {
        action: defaultAction(actor, found.scan),
        card,
        history: proof.history,
        photoUrl: proof.photoUrl,
      }),
      evaluatedSnapshot: found.liveCandidate ?? null,
    };
  }
  const [results, displayHistory] = await Promise.all([
    counts.stmts.length ? ctx.env.DB.batch(counts.stmts) : Promise.resolve([]),
    found ? historyPlan(ctx, actor, found) : Promise.resolve(null),
  ]);
  const read = await counts.read(results);
  if (evaluated.reason === 'test_pass' || evaluated.reason === 'live_pass') {
    const other = (candidateRead.candidates ?? []).filter(
      (candidate) => candidate.pass.mode !== actor.mode,
    );
    if (!other.length) return unknown();
    const proofs = () => other.map((candidate) => candidateDetectionProof(actor, candidate, credentials));
    const absence = await inputCandidates(ctx, actor, req.input, credentials, candidateEligible);
    if (
      !(await currentInputActor(
        ctx,
        actor,
        csrfSnapshot,
        evaluated.credentialTombstoneRefs,
        evaluated.credentialKeysetCommitment,
        evaluated.otherModeCredentialTombstoneRefs,
        true,
        undefined,
        proofs,
        absence,
      ))
    )
      return unknown();
    return {
      outcome: { ...blankOutcome('refused', read), reason: evaluated.reason },
      evaluatedSnapshot: null,
    };
  }
  let history: FinalizedDisplayHistory | null = null;
  let photoUrl: string | null = null;
  if (found) {
    if (!displayHistory) return unknown();
    const proof = await currentFound(ctx, actor, found, displayHistory, csrfSnapshot, photoGrant);
    if (!proof) return unknown();
    history = proof.history;
    photoUrl = proof.photoUrl;
  } else if (evaluated.pass) {
    return unknown();
  } else if (evaluated.auditPassId || evaluated.auditPassSnapshot || evaluated.auditCandidate) {
    const candidate = evaluated.auditCandidate;
    if (
      !candidate ||
      candidate.pass.id !== evaluated.auditPassId ||
      !evaluated.auditPassSnapshot ||
      JSON.stringify(candidateAudit(candidate).auditPassSnapshot) !==
        JSON.stringify(evaluated.auditPassSnapshot)
    )
      return unknown();
    const now = ctx.clock.now();
    const csrf = actorCsrfSnapshotFence(
      actor,
      csrfSnapshot.session
        ? { ...csrfSnapshot, session: { ...csrfSnapshot.session, now } }
        : csrfSnapshot,
    );
    if (!csrf) return unknown();
    const authority = outputAuthorityPredicate({
      actor,
      now,
      event: actor.event,
      templateId: candidate.pass.templateId,
      credentialTombstoneRefs: candidate.credentialTombstoneRefs,
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      release: candidate,
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      extra: csrf,
    });
    const result = await outputPredicateStmt(ctx.env.DB, authority).first<{ authorized: number }>();
    if (result?.authorized !== 1) return unknown();
  } else {
    const reason = evaluated.reason;
    const candidates =
      reason === 'not_found'
        ? await inputCandidates(ctx, actor, req.input, credentials)
        : undefined;
    const configOnly =
      actor.principal === 'scanner' &&
      actor.templateIds.length === 0 &&
      !actor.settings.acceptAllTemplates;
    const sameMode = (candidateRead.candidates ?? []).filter(
      (candidate) => candidate.pass.mode === actor.mode,
    );
    const relevant =
      reason === 'wrong_event'
        ? sameMode.filter((candidate) => accepts(actor, candidate.pass))
        : reason === 'ambiguous'
          ? sameMode.filter(
              (candidate) => accepts(actor, candidate.pass) && matchesEvent(actor, candidate.pass),
            )
          : sameMode;
    if (
      !configOnly &&
      (reason === 'wrong_event' || reason === 'not_accepted' || reason === 'ambiguous') &&
      relevant.length < (reason === 'ambiguous' ? 2 : 1)
    )
      return unknown();
    const proofs = (now: number) =>
      !configOnly &&
      (reason === 'wrong_event' || reason === 'not_accepted' || reason === 'ambiguous')
        ? relevant.map((candidate) => candidateReadProof(actor, candidate, credentials, now))
        : [];
    const absence =
      !configOnly && (reason === 'wrong_event' || reason === 'not_accepted')
        ? await inputCandidates(
            ctx,
            actor,
            req.input,
            credentials,
            acceptedFilter(actor, reason === 'wrong_event'),
          )
        : undefined;
    if (
      !(await currentInputActor(
        ctx,
        actor,
        csrfSnapshot,
        evaluated.credentialTombstoneRefs,
        evaluated.credentialKeysetCommitment,
        undefined,
        false,
        candidates,
        proofs,
        absence,
      ))
    )
      return unknown();
  }
  return {
    outcome: stopOutcome(ctx, actor, evaluated, read, {
      action: found ? defaultAction(actor, found.scan) : null,
      history: history ?? undefined,
      photoUrl,
    }),
    evaluatedSnapshot: found?.liveCandidate ?? null,
  };
}
