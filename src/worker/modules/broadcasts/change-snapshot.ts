import { PASS_SELECTION_MAX } from '../../../shared/contracts/pass-selection.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { safeTargetFilter } from './apply.ts';
import type { BroadcastRow } from './repo.ts';
import { addTargets } from './repo-selection.ts';
import { targetPage } from './repo-target.ts';

const PAGE = 1000;

/**
 * Takes the passes a change run's filters or import match right now into its target rows, newest
 * first in pages by id. False when more than `PASS_SELECTION_MAX` match: the run then applies nothing.
 */
export async function snapshotTargets(ctx: ServiceContext, row: BroadcastRow): Promise<boolean> {
  let cursor: string | null = null;
  let total = 0;
  for (;;) {
    const filter = safeTargetFilter(row, cursor, PAGE, true);
    if (!filter) return true;
    const page = await targetPage(ctx.env.DB, filter, ctx.clock.now());
    if (page.ids.length > 0) await addTargets(ctx.env.DB, row.id, page.ids);
    total += page.ids.length;
    if (total > PASS_SELECTION_MAX) return false;
    if (!page.nextCursor) return true;
    cursor = page.nextCursor;
  }
}
