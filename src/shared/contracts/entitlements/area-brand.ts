import { type EntitlementDef, level, limit } from './kinds.ts';

export const AREA_BRAND = {
  'brand.mark': level(['none', 'quiet', 'full'], ['full', 'full', 'quiet', 'none', 'none', 'full']),
  domains: limit([0, 0, 1, 5, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
