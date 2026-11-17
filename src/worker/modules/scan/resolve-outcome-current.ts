import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import { takeAssetGrantToken } from './asset-sidecar.ts';
import type { CardRead } from './card.ts';
import type { ScanActor } from './guard.ts';
import { type PreparedPhotoGrant, photoGrantUrl } from './member-photo.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import {
  currentFoundActorStmt,
  currentFoundExtra,
  currentFoundTemplate,
  headMoved,
  passChanged,
} from './repo-resolve-outcome-current.ts';
import type { Found } from './resolve.ts';
import type { DisplayHistoryPlan, FinalizedDisplayHistory } from './scan-display-history.ts';

async function currentFoundRead(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  displayHistory: DisplayHistoryPlan,
  csrfSnapshot: ActorCsrfSnapshot,
  photoGrant: PreparedPhotoGrant | null,
  historyFence?: CardRead['historyFence'],
  passViewGrant?: CardRead['passViewGrant'],
): Promise<{
  history: FinalizedDisplayHistory;
  cardHistoryCurrent: boolean;
  passViewToken: string | null;
  photoUrl: string | null;
} | null> {
  try {
    const original = found.liveCandidate;
    if (!original) return null;
    const template = currentFoundTemplate(original);
    if (!template) return null;
    const now = ctx.clock.now();
    const csrf = actorCsrfSnapshotFence(
      actor,
      csrfSnapshot.session
        ? { ...csrfSnapshot, session: { ...csrfSnapshot.session, now } }
        : csrfSnapshot,
    );
    if (!csrf) return null;
    const predicate = outputAuthorityPredicate({
      actor,
      now,
      event: found.admission?.event ?? actor.event,
      templateId: found.pass.templateId,
      credentialTombstoneRefs: found.credentialTombstoneRefs,
      credentialKeysetCommitment: found.credentialKeysetCommitment,
      pass: original.pass,
      connectionGeneration: found.connectionGeneration,
      activeTemplateVersion: found.activeVersion,
      orgRevision: found.orgRevision,
      templateRevision: found.templateRevision,
      release: found,
      displayTemplateVersion: found.displayTemplateVersion,
      checkInRules: found.checkInRules,
      lookupHash: original.lookupHash,
      requireActive: true,
      requirePhoto: !!photoGrant,
      extra: currentFoundExtra(csrf, template),
    });
    const bound = displayHistory.bind(now, predicate);
    const cardFence = historyFence ? outputPredicateStmt(ctx.env.DB, historyFence) : null;
    const results = await ctx.env.DB.batch<Record<string, unknown>>([
      ...bound.stmts,
      ...(cardFence ? [cardFence] : []),
      currentFoundActorStmt(ctx.env.DB, csrf),
    ]);
    const csrfIndex = bound.stmts.length + (cardFence ? 1 : 0);
    if (results[csrfIndex]?.results?.[0]?.actor_authorized !== 1) return null;
    const history = bound.finalize(results.slice(0, bound.stmts.length));
    if (!history) return null;
    const passViewToken = passViewGrant ? takeAssetGrantToken(passViewGrant) : null;
    if (passViewGrant && !passViewToken) return null;
    const photoUrl = photoGrant ? photoGrantUrl(actor, original.pass.id, photoGrant.grant) : null;
    if (photoGrant && !photoUrl) return null;
    return {
      history,
      passViewToken,
      photoUrl,
      cardHistoryCurrent: !cardFence || results[bound.stmts.length]?.results?.[0]?.authorized === 1,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** The fenced read, or null when the pass is gone; a head that moved to another version is a 409. */
export async function currentFound(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  displayHistory: DisplayHistoryPlan,
  csrfSnapshot: ActorCsrfSnapshot,
  photoGrant: PreparedPhotoGrant | null,
  historyFence?: CardRead['historyFence'],
  passViewGrant?: CardRead['passViewGrant'],
) {
  const result = await currentFoundRead(
    ctx,
    actor,
    found,
    displayHistory,
    csrfSnapshot,
    photoGrant,
    historyFence,
    passViewGrant,
  );
  if (!result && found.liveCandidate && (await headMoved(ctx.env.DB, found.liveCandidate)))
    throw passChanged();
  return result;
}
