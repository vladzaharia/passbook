import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { historyPlan } from './card.ts';
import type { ScanActor } from './guard.ts';
import type { PreloadedDisplayHistory } from './history-proof-plan.ts';
import { type PreparedPhotoGrant, photoGrantUrl } from './member-photo.ts';
import { safeDisplay } from './outcome.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import type { Found } from './resolve.ts';

/** Prepare the held result's history; the caller's grant batch is its only authority. */
export async function prepareCommittedDisplay(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  authorityActor: ScanActor,
  screen: 'ok' | 'heads_up',
  photo: PreparedPhotoGrant | null,
  history?: PreloadedDisplayHistory,
): Promise<{
  bind(
    now: number,
    authority: OutputPredicate,
  ): {
    /** Display reads: they run with the commit and must see it. */
    reads: D1PreparedStatement[];
    finish(reads: readonly D1Result[]): ScanDisplay | null;
  };
}> {
  const planned = await historyPlan(ctx, actor, found, history);
  return {
    bind(now, authority) {
      const bound = planned.bind(now, authority);
      return {
        reads: bound.stmts,
        finish(reads) {
          const history = bound.finalize(reads);
          if (!history) return null;
          const photoUrl = photo ? photoGrantUrl(authorityActor, found.pass.id, photo.grant) : null;
          return safeDisplay(ctx, actor, found.pass, screen, { found, history, photoUrl });
        },
      };
    },
  };
}
