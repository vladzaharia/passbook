import type { EntitlementKey, EntitlementPreset } from '../contracts/entitlements.ts';

export const FEATURES_LABEL = 'Features';

/** `{feature}` is an ENTITLEMENT_LABEL. */
export const FEATURE_NOT_INCLUDED_COPY = "{feature} isn't included for this organization.";
export const FEATURE_ASK = 'Ask PassBook to turn it on.';
/** A control or row whose feature the plan lacks. */
export const NOT_INCLUDED = 'Not included for this organization.';
/** `{feature}` is an ENTITLEMENT_LABEL. */
export const LIMIT_REACHED_COPY = '{feature}: limit reached for this organization.';
export const LIMIT_ASK = 'Ask PassBook for more.';

export const ENTITLEMENT_LABEL: Record<EntitlementKey, string> = {
  api: 'API access',
  'api.rateTier': 'API rate tier',
  'api.keys': 'API keys',
  apps: 'Apps',
  webhooks: 'Webhooks',
  'webhooks.endpoints': 'Webhook endpoints',
  connections: 'Connections',
  connectors: 'Connectors',
  'wallet.google': 'Google Wallet',
  'wallet.samsung': 'Samsung Wallet',
  print: 'Print at home',
  nfc: 'NFC tags',
  'scanning.devices': 'Scanner devices',
  'join.perDay': 'Join passes per day',
  'messages.perDay': 'Broadcasts per day',
  'passes.live': 'Live passes',
  'passes.test': 'Test passes',
  templates: 'Templates',
  'templates.uploads': 'Template uploads',
  'templates.stylesBlocked': 'Blocked pass styles',
  'email.perDay': 'Emails per day',
  members: 'Members',
  'brand.mark': 'PassBook mark',
  domains: 'Custom domains',
  'identity.own': 'Own Pass Type ID',
};

/** Level values by key; every level of the registry has a label. */
export const ENTITLEMENT_LEVEL_LABEL: Partial<Record<EntitlementKey, Record<string, string>>> = {
  api: { off: 'Off', read: 'Read only', full: 'Full' },
  'api.rateTier': { standard: 'Standard', high: 'High', bulk: 'Bulk' },
  nfc: { off: 'Off', basic: 'Basic', secure: 'Secure' },
  'brand.mark': { none: 'None', quiet: 'Quiet', full: 'Full' },
};

export const PRESET_LABEL: Record<EntitlementPreset, string> = {
  legacy: 'Legacy',
  trial: 'Trial',
  standard: 'Standard',
};

export const featureNotIncluded = (key: EntitlementKey): string =>
  `${FEATURE_NOT_INCLUDED_COPY.replace('{feature}', ENTITLEMENT_LABEL[key])} ${FEATURE_ASK}`;

export const limitReached = (key: EntitlementKey): string =>
  `${LIMIT_REACHED_COPY.replace('{feature}', ENTITLEMENT_LABEL[key])} ${LIMIT_ASK}`;

/** The one-sentence refusal of a create at its cap; `used` is what the organization holds. */
export const limitRefusal = (key: EntitlementKey, limit: number, used: number): string =>
  `${ENTITLEMENT_LABEL[key]} limit reached (${used} of ${limit}), ask PassBook for more.`;
