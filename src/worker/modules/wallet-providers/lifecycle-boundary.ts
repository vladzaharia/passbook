import {
  DEFAULT_EVENT_MINUTES,
  nextBoundary,
  passBoundaries,
} from '../../../passkit/boundaries.ts';
import type { PassJson } from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { eventMinutes, walletBoundaryPass } from '../passes/timed-pass.ts';
import { readTimedSource } from '../passes/timed-source.ts';

export { boundaryPhase, nextBoundary, passBoundaries } from '../../../passkit/boundaries.ts';

/**
 * Moments a compiled wallet card changes with no pass edit (architecture 6.1): the pass expires, or an
 * upcoming event starts or ends. The calculation Apple's timed renders use, over every input event (an event
 * past the cap of 10 moves up when an earlier one ends) and the expiry the last of them leaves, so a boundary
 * is one operation and the card it sends is the timed one (docs/design/event-boundaries.md).
 */
export async function walletBoundaries(ctx: ServiceContext, passId: string): Promise<number[]> {
  const source = await readTimedSource(ctx, passId);
  if (!source) return [];
  const { built, personalization, template } = source;
  let pass: PassJson = built;
  if (template)
    try {
      pass = walletBoundaryPass(built, personalization, template);
    } catch (error) {
      // The behavior refuses the input now: the boundaries of the pass as built.
      ctx.log.warn('wallet.boundary_input_invalid', { passId, code: 'TIMED_PASS_INVALID', error });
    }
  const fallbackMinutes = template ? eventMinutes(template) : DEFAULT_EVENT_MINUTES;
  return passBoundaries(pass, { expiry: true, fallbackMinutes });
}

/** When the instance's card next changes by itself: the drain parks the instance's dirty row until then. */
export async function nextInstanceBoundary(
  ctx: ServiceContext,
  passId: string,
): Promise<number | null> {
  return nextBoundary(await walletBoundaries(ctx, passId), ctx.clock.now());
}
