import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { ConflictError, FeatureNotIncludedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';

/**
 * Third-party NFC tags work when the platform switch `nfc.tagsEnabled` and the org switch `nfc.tags`
 * are both on (both default on) and the org's plan includes NFC (`nfc` at least Basic). Apple NFC
 * (`nfc.enabled`) is a separate switch.
 */
export async function tagsEnabled(ctx: ServiceContext, orgId: string): Promise<boolean> {
  return (await tagsRefusal(ctx, orgId)) === null;
}

/** Why tags do not work for the org, as the error a write answers with; null when they do. */
export async function tagsRefusal(
  ctx: ServiceContext,
  orgId: string,
): Promise<FeatureNotIncludedError | ConflictError | null> {
  const [platform, org, entitlements] = await Promise.all([
    getPlatformSettings(ctx),
    getOrgSettings(ctx, orgId),
    entitlementsOf(ctx, orgId),
  ]);
  if (!isEntitled(entitlements, 'nfc', 'basic'))
    return new FeatureNotIncludedError('nfc', featureNotIncluded('nfc'));
  return platform['nfc.tagsEnabled'] && org['nfc.tags'].enabled
    ? null
    : new ConflictError('Turn on tags in settings first.', 'TAGS_OFF');
}
