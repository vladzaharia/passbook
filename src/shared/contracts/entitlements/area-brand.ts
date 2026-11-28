import { type EntitlementDef, level, limit } from './kinds.ts';

export const AREA_BRAND = {
  'brand.mark': level(
    ['none', 'quiet', 'full'],
    ['full', 'quiet', 'quiet', 'none', 'none', 'none', 'none', 'full'],
  ),
  domains: limit([0, 0, 0, 1, 3, null, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
