import type { z } from 'zod';
import type { ScanResolveRequestSchema } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import { type CardRead, historyPlan, readCard, readyOutcome, renderCardDisplay } from './card.ts';
import type { CountsPlan } from './counts.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { knownPhotoUrl } from './member-photo.ts';
import { blankOutcome, notAcceptedOutcome, stopOutcome } from './outcome.ts';
import type { Candidate } from './repo-lookup.ts';
import { SESSION_READ, scanAuthorizedStmt, scanReadAuthority } from './repo-read-authority.ts';
import { ACTOR_TENANT, passLineageFence } from './repo-read-fences.ts';
import { matchingPassSql } from './repo-resolve-passless-read.ts';
import { accepts, candidateAudit, matchesEvent } from './resolve-candidates.ts';
import { evaluate } from './resolve-evaluate.ts';
import { currentFound } from './resolve-outcome-current.ts';
import {
  acceptedFilter,
  candidateEligible,
  countNotFound,
  inputMatch,
  passlessCurrent,
} from './resolve-passless-read.ts';
import type { FinalizedDisplayHistory } from './scan-display-history.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { staleScanRead } from './stale-read.ts';

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
    if (!Array.isArray(evaluated.otherModeCredentialTombstoneRefs)) return unknown();
    const match = await inputMatch(ctx, actor, req.input, credentials);
    if (
      !(await passlessCurrent(ctx, actor, {
        refs: evaluated.credentialTombstoneRefs,
        otherRefs: evaluated.otherModeCredentialTombstoneRefs,
        appeared: matchingPassSql(match, ACTOR_TENANT, candidateEligible),
        lineage: other.map((candidate) => passLineageFence(actor, candidate.pass, false)),
      }))
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
    const proof = await currentFound(ctx, actor, found, displayHistory, photoGrant);
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
    if (
      !(await passlessCurrent(ctx, actor, {
        refs: candidate.credentialTombstoneRefs,
        lineage: [passLineageFence(actor, candidate.pass, true)],
      }))
    )
      return unknown();
  } else {
    const reason = evaluated.reason;
    const configOnly =
      actor.principal === 'scanner' &&
      actor.templateIds.length === 0 &&
      !actor.settings.acceptAllTemplates;
    // An invalid scope accepts nothing: the bare refusal `act` gives, under the same redacted-scope
    // authority the session read uses (the scan fence refuses every invalid scope).
    if (configOnly && actor.invalidScannerScope) {
      const auth = scanReadAuthority(actor, { now: ctx.clock.now(), read: SESSION_READ });
      const current = await scanAuthorizedStmt(ctx.env.DB, auth).first<{ authorized: number }>();
      if (current?.authorized !== 1) throw await staleScanRead(ctx, actor);
      return { outcome: notAcceptedOutcome().outcome, evaluatedSnapshot: null };
    }
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
    const observed =
      !configOnly &&
      (reason === 'wrong_event' || reason === 'not_accepted' || reason === 'ambiguous');
    if (observed && relevant.length < (reason === 'ambiguous' ? 2 : 1)) return unknown();
    const match =
      reason === 'not_found' || (observed && reason !== 'ambiguous')
        ? await inputMatch(ctx, actor, req.input, credentials)
        : null;
    // A miss is counted, in one grant that also holds the actor and the credential's refs.
    const current =
      reason === 'not_found'
        ? await countNotFound(ctx, actor, match, evaluated.credentialTombstoneRefs)
        : await passlessCurrent(ctx, actor, {
            refs: evaluated.credentialTombstoneRefs,
            ...(observed
              ? { lineage: relevant.map((c) => passLineageFence(actor, c.pass, false)) }
              : {}),
            ...(observed && reason !== 'ambiguous'
              ? {
                  appeared: matchingPassSql(
                    match,
                    ACTOR_TENANT,
                    acceptedFilter(actor, reason === 'wrong_event'),
                  ),
                }
              : {}),
          });
    if (!current) return unknown();
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
