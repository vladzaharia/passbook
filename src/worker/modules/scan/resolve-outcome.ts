import type { z } from 'zod';
import type { ScanOutcome, ScanResolveRequestSchema } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction, ResolvedScanManifest } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { historyPlan, readCard, readyOutcome } from './card.ts';
import { planCounts } from './counts.ts';
import type { ScanActor } from './guard.ts';
import { countMiss } from './misses.ts';
import { stopOutcome } from './outcome.ts';
import { evaluate } from './resolve.ts';

/** The scanner's default action, else the template's first. */
export function defaultAction(
  actor: ScanActor,
  scan: ResolvedScanManifest,
): ResolvedScanAction | null {
  const wanted = actor.settings.defaultActionId;
  return scan.actions.find((a) => a.id === wanted) ?? scan.actions[0] ?? null;
}

/**
 * `POST /resolve`: steps 5-13 of SA 2.6 and the desk card. A read: no scan row, no idempotency
 * entry. A found pass that passes every step is `ready`; one held by a window or a stop flag is a
 * heads-up that still carries the card.
 */
export async function resolveOutcome(
  ctx: ServiceContext,
  actor: ScanActor,
  req: z.infer<typeof ScanResolveRequestSchema>,
): Promise<ScanOutcome> {
  const counts = planCounts(ctx, actor, req.dayStart);
  const evaluated = await evaluate(ctx, actor, req.input);
  if (!evaluated.stop) {
    const { card, read } = await readCard(ctx, actor, evaluated.found, counts);
    return readyOutcome(evaluated.found, card, read);
  }
  if (evaluated.reason === 'not_found') await countMiss(ctx, actor);
  const found = evaluated.found;
  if (found && evaluated.kind === 'heads_up') {
    const { card, read } = await readCard(ctx, actor, found, counts);
    return stopOutcome(ctx, actor, evaluated, read, {
      action: defaultAction(actor, found.scan),
      card,
    });
  }
  const history = found ? historyPlan(ctx, actor, found) : null;
  const results = await ctx.env.DB.batch([...counts.stmts, ...(history?.stmts ?? [])]);
  const read = await counts.read(results.slice(0, counts.stmts.length));
  return stopOutcome(ctx, actor, evaluated, read, {
    action: found ? defaultAction(actor, found.scan) : null,
    history: history?.read(results.slice(counts.stmts.length)),
  });
}
