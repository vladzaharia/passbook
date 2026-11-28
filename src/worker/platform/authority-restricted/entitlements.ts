import { CREATOR_ORG_PURPOSE, PERSONAL_ORG_PURPOSE } from '../authority-personal.ts';
import type { RestrictedEntries } from './types.ts';

/** The cron that retires one org's expired overrides and journals the change like a platform save (org scope: the grant pins the tenant). */
export const ENTITLEMENT_EXPIRY_PURPOSE = 'org.job.entitlement_expiry';

/** Entitlements (0134) are platform-only (design-multi-tenancy.md section 2.2): an org never writes its own. */
export const entitlementsRestricted: RestrictedEntries = {
  restricted: {
    org_entitlements: [
      'platform.org.create',
      PERSONAL_ORG_PURPOSE,
      CREATOR_ORG_PURPOSE,
      'platform.job.template_sync',
      'platform.job.developer_sandbox.create',
      'platform.org.entitlements_set',
      ENTITLEMENT_EXPIRY_PURPOSE,
    ],
    org_entitlement_overrides: ['platform.org.entitlements_set', ENTITLEMENT_EXPIRY_PURPOSE],
    entitlement_preset_meta: ['platform.entitlement_preset.update'],
    entitlement_presets: ['platform.entitlement_preset.update'],
  },
  // Baked-template sync creates the platform org with its `legacy` row, and must never change an org's entitlements.
  insertOnly: {
    org_entitlements: [
      'platform.job.template_sync',
      'platform.job.developer_sandbox.create',
      'platform.org.create',
      PERSONAL_ORG_PURPOSE,
      CREATOR_ORG_PURPOSE,
    ],
  },
};
