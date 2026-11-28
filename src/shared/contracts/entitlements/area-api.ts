import { type EntitlementDef, flag, level, limit } from './kinds.ts';

export const AREA_API = {
  api: level(
    ['off', 'read', 'full'],
    ['full', 'full', 'full', 'full', 'full', 'full', 'full', 'full'],
  ),
  'api.rateTier': level(
    ['standard', 'high', 'bulk'],
    ['standard', 'standard', 'high', 'high', 'bulk', 'bulk', 'bulk', 'standard'],
  ),
  'api.keys': limit([2, 2, 5, 12, 30, null, null, 3]),
  webhooks: flag([1, 1, 1, 1, 1, 1, 1, 1]),
  'webhooks.endpoints': limit([1, 2, 4, 15, 40, null, null, 3]),
} as const satisfies Record<string, EntitlementDef>;
