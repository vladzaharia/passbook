// Go live re-checks the Test waiver (billing AD5): a Test scanner may use waived door features, so a move
// to Live checks each one it uses against the Live plan. A key the registry does not have yet is not gated
// in Live either, so it is skipped until its package (E5, E6, E15) adds it. `scanning.displayCustom` rides
// the template's display, not the scanner, and is checked where that is promoted.
import { ENTITLEMENT_KEYS, type EntitlementKey } from '../../../shared/contracts/entitlements.ts';
import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { entitled, entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { FeatureNotIncludedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export interface LiveNeed {
  key: string;
  want?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The waived keys a scanner uses, by its role and settings. */
export function liveNeeds(role: string, settings: unknown): LiveNeed[] {
  const s = isObject(settings) ? settings : {};
  const needs: LiveNeed[] = [];
  if (role === 'customer') needs.push({ key: 'scanning.display' });
  if (role === 'monitor' || s.deskActions === true) needs.push({ key: 'scanning.desk' });
  if (role === 'kiosk') {
    needs.push({ key: 'scanning.selfCheckIn' });
    const walkIn = isObject(s.entries) && s.entries.walkIn === true;
    if (walkIn || (isObject(s.walkIn) && typeof s.walkIn.templateId === 'string'))
      needs.push({ key: 'scanning.kioskWalkIn' });
  }
  if (s.hardLimit === true) needs.push({ key: 'scanning.rules', want: 'capacity' });
  else if (s.direction === 'out' || s.direction === 'both')
    needs.push({ key: 'scanning.rules', want: 'inout' });
  if (s.approvals === 'desk') needs.push({ key: 'scanning.approvals' });
  return needs;
}

const gated = (needs: readonly LiveNeed[]): { key: EntitlementKey; want?: string }[] =>
  needs.flatMap((n) => {
    const key = ENTITLEMENT_KEYS.find((k) => k === n.key);
    if (key === undefined) return [];
    return [n.want === undefined ? { key } : { key, want: n.want }];
  });

/**
 * Refuses (403 FEATURE_NOT_INCLUDED, `feature` named) unless the Live plan has every key in `needs`, and
 * returns the same checks for the grant, so a plan change before the commit still refuses.
 */
export async function assertLiveFeatures(
  ctx: ServiceContext,
  orgId: string,
  needs: readonly LiveNeed[],
): Promise<Check[]> {
  const keys = gated(needs);
  if (keys.length === 0) return [];
  const live = await entitlementsOf(ctx, orgId);
  for (const { key, want } of keys)
    if (!isEntitled(live, key, want))
      throw new FeatureNotIncludedError(key, featureNotIncluded(key));
  return keys.map(({ key, want }) => entitled(key, want));
}
