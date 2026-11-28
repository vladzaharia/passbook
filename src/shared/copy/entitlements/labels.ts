import type { EntitlementKey } from '../../contracts/entitlements.ts';
import { LABEL_ACCOUNT } from './area-account.ts';
import { LABEL_API, LEVEL_LABEL_API } from './area-api.ts';
import { LABEL_AUDIT } from './area-audit.ts';
import { LABEL_BRAND, LEVEL_LABEL_BRAND } from './area-brand.ts';
import { LABEL_BUNDLES } from './area-bundles.ts';
import { LABEL_CONNECTIONS } from './area-connections.ts';
import { LABEL_CORE } from './area-core.ts';
import { LABEL_IDENTITY } from './area-identity.ts';
import { LABEL_MESSAGES } from './area-messages.ts';
import { LABEL_NFC, LEVEL_LABEL_NFC } from './area-nfc.ts';
import { LABEL_PASSES } from './area-passes.ts';
import { LABEL_SCAN_CONSOLE } from './area-scan-console.ts';
import { LABEL_SCAN_DOOR } from './area-scan-door.ts';
import { LABEL_TEAM } from './area-team.ts';

export const ENTITLEMENT_LABEL: Record<EntitlementKey, string> = {
  ...LABEL_CORE,
  ...LABEL_BRAND,
  ...LABEL_AUDIT,
  ...LABEL_ACCOUNT,
  ...LABEL_PASSES,
  ...LABEL_MESSAGES,
  ...LABEL_SCAN_CONSOLE,
  ...LABEL_SCAN_DOOR,
  ...LABEL_NFC,
  ...LABEL_TEAM,
  ...LABEL_API,
  ...LABEL_IDENTITY,
  ...LABEL_BUNDLES,
  ...LABEL_CONNECTIONS,
};

/** Level values by key; every level of the registry has a label. */
export const ENTITLEMENT_LEVEL_LABEL: Partial<Record<EntitlementKey, Record<string, string>>> = {
  ...LEVEL_LABEL_BRAND,
  ...LEVEL_LABEL_NFC,
  ...LEVEL_LABEL_API,
};
