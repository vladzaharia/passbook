import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import { confirmAssetGrantToken } from './assets.ts';
import type { CardRead } from './card.ts';
import type { ScanActor } from './guard.ts';
import { confirmedPhotoUrl, type PreparedPhotoGrant } from './member-photo.ts';
import { isAssetGrantAuthorityFailure, prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import {
  currentFoundActorStmt,
  currentFoundExtra,
  currentFoundTemplate,
} from './repo-resolve-outcome-current.ts';
import type { Found } from './resolve.ts';
import type { DisplayHistoryPlan, FinalizedDisplayHistory } from './scan-display-history.ts';

export async function currentFound(
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
    const [preparePhoto, preparePassView] = await Promise.all([
      photoGrant
        ? prepareAssetGrantInsertion(
            ctx,
            photoGrant.grant,
            { recipientSnapshot: csrfSnapshot },
            original,
          )
        : null,
      passViewGrant
        ? prepareAssetGrantInsertion(
            ctx,
            passViewGrant,
            { recipientSnapshot: csrfSnapshot },
            original,
          )
        : null,
    ]);
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
    const photoInsert = preparePhoto ? preparePhoto(now, predicate) : [];
    const passViewInsert = preparePassView ? preparePassView(now, predicate) : [];
    const bound = displayHistory.bind(now, predicate);
    const cardFence = historyFence ? outputPredicateStmt(ctx.env.DB, historyFence) : null;
    const results = await ctx.env.DB.batch<Record<string, unknown>>([
      ...bound.stmts,
      ...(cardFence ? [cardFence] : []),
      ...photoInsert,
      ...passViewInsert,
      currentFoundActorStmt(ctx.env.DB, csrf),
    ]);
    const photoIndex = bound.stmts.length + (cardFence ? 1 : 0);
    const passViewIndex = photoIndex + photoInsert.length;
    const csrfIndex = passViewIndex + passViewInsert.length;
    if (results[csrfIndex]?.results?.[0]?.actor_authorized !== 1) return null;
    const history = bound.finalize(results.slice(0, bound.stmts.length));
    if (!history) return null;
    const passViewToken = passViewGrant
      ? confirmAssetGrantToken(
          passViewGrant,
          results.slice(passViewIndex, passViewIndex + passViewInsert.length),
        )
      : null;
    if (passViewGrant && !passViewToken) return null;
    const photoUrl = photoGrant
      ? confirmedPhotoUrl(
          actor,
          original.pass.id,
          photoGrant.grant,
          results.slice(photoIndex, photoIndex + photoInsert.length),
        )
      : null;
    if (photoGrant && !photoUrl) return null;
    return {
      history,
      passViewToken,
      photoUrl,
      cardHistoryCurrent: !cardFence || results[bound.stmts.length]?.results?.[0]?.authorized === 1,
    };
  } catch (error) {
    if (isNotFound(error) || isAssetGrantAuthorityFailure(error)) return null;
    throw error;
  }
}
