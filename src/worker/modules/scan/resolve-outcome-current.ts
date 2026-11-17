import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound } from '../passes/builder.ts';
import { takeAssetGrantToken } from './asset-sidecar.ts';
import type { CardRead } from './card.ts';
import type { ScanActor } from './guard.ts';
import { type PreparedPhotoGrant, photoGrantUrl, scannerPassActive } from './member-photo.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { passAnswerFence, underAuthority } from './repo-read-fences.ts';
import { headMoved, passChanged } from './repo-resolve-outcome-current.ts';
import type { Found } from './resolve.ts';
import type { DisplayHistoryPlan, FinalizedDisplayHistory } from './scan-display-history.ts';
import { predicateStmt } from './scan-predicate.ts';

async function currentFoundRead(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  displayHistory: DisplayHistoryPlan,
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
    const now = ctx.clock.now();
    // The pass is still the one the answer was read from, under the actor's authority now.
    const fence = passAnswerFence(actor, original, {
      photo: !!photoGrant,
      refs: found.credentialTombstoneRefs,
    });
    if (!fence) return null;
    const auth = scanReadAuthority(actor, { now, event: found.admission?.event ?? null });
    const bound = displayHistory.bind(now, underAuthority(auth, fence));
    const cardFence = historyFence ? predicateStmt(ctx.env.DB, historyFence) : null;
    const results = await ctx.env.DB.batch<Record<string, unknown>>([
      ...bound.stmts,
      ...(cardFence ? [cardFence] : []),
    ]);
    const history = bound.finalize(results.slice(0, bound.stmts.length));
    // A Wallet that expired by the final clock is no longer a pass to show.
    if (!history || !scannerPassActive(original, found.passJson, now)) return null;
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
  photoGrant: PreparedPhotoGrant | null,
  historyFence?: CardRead['historyFence'],
  passViewGrant?: CardRead['passViewGrant'],
) {
  const result = await currentFoundRead(
    ctx,
    actor,
    found,
    displayHistory,
    photoGrant,
    historyFence,
    passViewGrant,
  );
  if (!result && found.liveCandidate && (await headMoved(ctx.env.DB, found.liveCandidate)))
    throw passChanged();
  return result;
}
