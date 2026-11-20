import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';

/**
 * Third-party NFC tags work when the platform switch `nfc.tagsEnabled` and the org switch `nfc.tags`
 * are both on (both default on). Apple NFC (`nfc.enabled`) is a separate switch.
 */
export async function tagsEnabled(ctx: ServiceContext, orgId: string): Promise<boolean> {
  const [platform, org] = await Promise.all([getPlatformSettings(ctx), getOrgSettings(ctx, orgId)]);
  return platform['nfc.tagsEnabled'] && org['nfc.tags'].enabled;
}
