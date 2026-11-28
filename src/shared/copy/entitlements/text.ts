import type { EntitlementKey, EntitlementPreset } from '../../contracts/entitlements.ts';
import { ENTITLEMENT_LABEL } from './labels.ts';

export const FEATURES_LABEL = 'Features';

/** `{feature}` is an ENTITLEMENT_LABEL. */
export const FEATURE_NOT_INCLUDED_COPY = "{feature} isn't included for this organization.";
export const FEATURE_ASK = 'Ask PassBook to turn it on.';
/** A control or row whose feature the plan lacks. */
export const NOT_INCLUDED = 'Not included for this organization.';
/** `{feature}` is an ENTITLEMENT_LABEL. */
export const LIMIT_REACHED_COPY = '{feature}: limit reached for this organization.';
export const LIMIT_ASK = 'Ask PassBook for more.';

export const PRESET_LABEL: Record<EntitlementPreset, string> = {
  trial: 'Trial',
  starter: 'Starter',
  standard: 'Standard',
  premium: 'Premium',
  legacy: 'Unlimited',
  developer: 'Developer sandbox',
};

export const featureNotIncluded = (key: EntitlementKey): string =>
  `${FEATURE_NOT_INCLUDED_COPY.replace('{feature}', ENTITLEMENT_LABEL[key])} ${FEATURE_ASK}`;

export const limitReached = (key: EntitlementKey): string =>
  `${LIMIT_REACHED_COPY.replace('{feature}', ENTITLEMENT_LABEL[key])} ${LIMIT_ASK}`;

/** The one-sentence refusal of a create at its cap; `used` is what the organization holds. */
export const limitRefusal = (key: EntitlementKey, limit: number, used: number): string =>
  `${ENTITLEMENT_LABEL[key]} limit reached (${used} of ${limit}), ask PassBook for more.`;
