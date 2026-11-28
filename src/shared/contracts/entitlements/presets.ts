import { z } from 'zod';

/**
 * What an organization may use (entitlements, "Features" in the UI), as opposed to what a role may do
 * (`OrgCapability`). One registry holds every key; presets are columns of it, so a preset that forgets a key
 * does not compile. The migration seeds `entitlement_presets` from it and a test holds the two equal.
 *
 * Values are stored as JSON text. A missing or malformed value denies; JSON `null` means "no limit" and is
 * valid for a limit only.
 */
export const ENTITLEMENT_PRESETS = [
  'trial',
  'starter',
  'standard',
  'premium',
  'legacy',
  'developer',
] as const;
export const EntitlementPresetSchema = z.enum(ENTITLEMENT_PRESETS);
export type EntitlementPreset = z.infer<typeof EntitlementPresetSchema>;

/** Orders preset ids as the registry lists them (the ladder); an id it does not know sorts last, then by id. */
export function presetOrder(a: string, b: string): number {
  const rank = (id: string) => {
    const at = (ENTITLEMENT_PRESETS as readonly string[]).indexOf(id);
    return at < 0 ? ENTITLEMENT_PRESETS.length : at;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
