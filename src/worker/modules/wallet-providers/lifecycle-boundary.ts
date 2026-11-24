import { nextBoundary, passBoundaries } from '../../../passkit/boundaries.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from '../passes/builder.ts';
import { boundarySource } from '../passes/repo-boundaries.ts';
import { eventMinutes } from '../passes/timed-pass.ts';

export { boundaryPhase, nextBoundary, passBoundaries } from '../../../passkit/boundaries.ts';

/**
 * Moments a compiled wallet card changes with no pass edit (architecture 6.1): the pass expires, or an
 * upcoming event starts or ends. The calculation Apple's timed renders use, with the template's event
 * length, so a boundary is one operation, and the card it sends is the timed one (docs/design/event-boundaries.md).
 */
export async function walletBoundaries(ctx: ServiceContext, passId: string): Promise<number[]> {
  const source = await boundarySource(ctx.env.DB, passId);
  const raw = source?.passJson ?? null;
  if (!source || raw === null || !raw.includes('"upcomingPassInformation"'))
    return passBoundaries(raw, { expiry: true });
  let fallbackMinutes: number | undefined;
  try {
    const template = await resolveTemplate(
      ctx,
      source.orgId,
      source.templateId,
      source.templateVersion,
    );
    fallbackMinutes = eventMinutes(template);
  } catch (error) {
    // A template that is gone keeps the default event length; anything else retries the drain.
    if (!isNotFound(error)) throw error;
    ctx.log.warn('wallet.boundary_template_missing', { passId, code: 'TEMPLATE_NOT_FOUND' });
  }
  return passBoundaries(raw, { expiry: true, ...(fallbackMinutes ? { fallbackMinutes } : {}) });
}

/** When the instance's card next changes by itself: the drain parks the instance's dirty row until then. */
export async function nextInstanceBoundary(
  ctx: ServiceContext,
  passId: string,
): Promise<number | null> {
  return nextBoundary(await walletBoundaries(ctx, passId), ctx.clock.now());
}
