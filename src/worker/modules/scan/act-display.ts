import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { historyPlan } from './card.ts';
import type { ScanActor } from './guard.ts';
import type { PreloadedDisplayHistory } from './history-proof-plan.ts';
import { confirmedPhotoUrl, type PreparedPhotoGrant } from './member-photo.ts';
import { safeDisplay } from './outcome.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import type { Candidate } from './repo-lookup.ts';
import { boundOutputPredicate, type OutputPredicate } from './repo-output-predicates.ts';
import type { Found } from './resolve.ts';

/** Prepare the held result's history and grant; the caller's grant batch is its only authority. */
export async function prepareCommittedDisplay(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  authorityActor: ScanActor,
  screen: 'ok' | 'heads_up',
  photo: PreparedPhotoGrant | null,
  csrf: ActorCsrfSnapshot,
  original: Candidate | null,
  history?: PreloadedDisplayHistory,
): Promise<{
  bind(
    now: number,
    authority: OutputPredicate,
  ): {
    /** Display reads: they run with the commit and must see it. */
    reads: D1PreparedStatement[];
    /** The photo grant insert: decoration after the commit (`decorateScan`). */
    photo: D1PreparedStatement[];
    finish(reads: readonly D1Result[], photo: readonly D1Result[]): ScanDisplay | null;
  };
}> {
  if (photo && !original) throw new StaleScanAuthority();
  const planned = await historyPlan(ctx, actor, found, history);
  const grant =
    photo && original
      ? await prepareAssetGrantInsertion(ctx, photo.grant, { recipientSnapshot: csrf }, original, {
          soft: true,
        })
      : null;
  return {
    bind(now, authority) {
      const bound = planned.bind(now, authority);
      return {
        reads: bound.stmts,
        photo: grant ? grant(now, boundOutputPredicate(authority), { sql: '1', params: [] }) : [],
        finish(reads, photoResults) {
          const history = bound.finalize(reads);
          if (!history) return null;
          const photoUrl = photo
            ? confirmedPhotoUrl(authorityActor, found.pass.id, photo.grant, photoResults)
            : null;
          return safeDisplay(ctx, actor, found.pass, screen, { found, history, photoUrl });
        },
      };
    },
  };
}
