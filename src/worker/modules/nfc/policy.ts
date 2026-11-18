import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';

/** Org-wide switch for third-party NFC tags: `settings` key `nfc.tags`, off until an admin turns it on. */
export async function tagsEnabled(ctx: ServiceContext, orgId: string): Promise<boolean> {
  return (await getOrgSettings(ctx, orgId))['nfc.tags'].enabled;
}
