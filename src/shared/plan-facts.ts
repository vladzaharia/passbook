import { type EntitlementKey, parseEntitlementValue } from './contracts/entitlements.ts';
import type { EntitlementValues } from './entitlement-impact.ts';

/** A cap: `null` is no limit. */
export type Cap = number | null;
/** The smallest PassBook footer a plan allows. */
export type FooterLevel = 'full' | 'quiet' | 'none';
export type NfcLevel = 'off' | 'basic' | 'secure';

export interface PlanFacts {
  passes: Cap;
  templates: Cap;
  google: boolean;
  samsung: boolean;
  print: boolean;
  nfc: NfcLevel;
  footer: FooterLevel;
}

const cap = (values: EntitlementValues, key: EntitlementKey): Cap => {
  const v = parseEntitlementValue(key, values[key]);
  return v === null || typeof v === 'number' ? v : 0;
};
const on = (values: EntitlementValues, key: EntitlementKey): boolean =>
  parseEntitlementValue(key, values[key]) === 1;
const levelOf = <L extends string>(
  values: EntitlementValues,
  key: EntitlementKey,
  fallback: L,
): L => {
  const v = parseEntitlementValue(key, values[key]);
  return (typeof v === 'string' ? v : fallback) as L;
};

/**
 * The few facts a plan card shows, computed from the plan's values so an edit to a plan shows without
 * a copy change. A missing or invalid value fails closed: off, 0, the full footer.
 */
export function planFacts(values: EntitlementValues): PlanFacts {
  return {
    passes: cap(values, 'passes.live'),
    templates: cap(values, 'templates'),
    google: on(values, 'wallet.google'),
    samsung: on(values, 'wallet.samsung'),
    print: on(values, 'print'),
    nfc: levelOf<NfcLevel>(values, 'nfc', 'off'),
    footer: levelOf<FooterLevel>(values, 'brand.mark', 'full'),
  };
}
