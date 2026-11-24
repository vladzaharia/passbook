import { levelsAtLeast } from '../../../shared/contracts/entitlements.ts';
import type { BrandMark } from '../../../shared/contracts/orgs.ts';
import { type Entitlements, entitlementsOf } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** Least PassBook first; the `brand.mark` level `quiet` is the small mark. */
const ORDER: readonly BrandMark[] = ['none', 'small', 'full'];

/** The marks a plan's `brand.mark` value allows: the value is the least it may show. Missing or invalid: full only. */
export function marksOf(value: Entitlements['brand.mark']): readonly BrandMark[] {
  const levels = typeof value === 'string' ? levelsAtLeast('brand.mark', value) : [];
  if (levels.length === 0) return ['full'];
  return ORDER.filter((m) => levels.includes(m === 'small' ? 'quiet' : m));
}

/** The mark levels the org's plan allows (`brand.mark`), least PassBook first. */
export async function allowedMarks(
  ctx: ServiceContext,
  orgId: string,
): Promise<readonly BrandMark[]> {
  return marksOf((await entitlementsOf(ctx, orgId))['brand.mark']);
}

/** The chosen level when allowed; otherwise the nearest allowed one with more PassBook. The stored choice is never rewritten: a plan that allows it again brings it back. */
export const effectiveMark = (
  chosen: BrandMark | undefined,
  allowed: readonly BrandMark[],
): BrandMark =>
  ORDER.slice(ORDER.indexOf(chosen ?? 'full')).find((m) => allowed.includes(m)) ?? 'full';
