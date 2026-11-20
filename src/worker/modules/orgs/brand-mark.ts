import type { BrandMark } from '../../../shared/contracts/orgs.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/**
 * The mark levels an org may use. `none` is an entitlement (`brand.mark`, MT4): until it is wired,
 * every org keeps `full` and `small`. The one place MT4 changes.
 */
export async function allowedMarks(
  _ctx: ServiceContext,
  _orgId: string,
): Promise<readonly BrandMark[]> {
  return ['full', 'small'];
}

/** The chosen level when the org may use it; otherwise full. The stored choice is never changed. */
export const effectiveMark = (
  chosen: BrandMark | undefined,
  allowed: readonly BrandMark[],
): BrandMark => (chosen && allowed.includes(chosen) ? chosen : 'full');
