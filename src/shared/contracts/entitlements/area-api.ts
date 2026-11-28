import { type EntitlementDef, flag, level, limit } from './kinds.ts';

export const AREA_API = {
  api: level(['off', 'read', 'full'], ['full', 'full', 'full', 'full', 'full', 'full']),
  'api.rateTier': level(
    ['standard', 'high', 'bulk'],
    ['standard', 'standard', 'high', 'bulk', 'bulk', 'standard'],
  ),
  'api.keys': limit([2, 3, 10, 50, null, 3]),
  apps: flag([0, 0, 1, 1, 1, 0]),
  webhooks: flag([0, 1, 1, 1, 1, 1]),
  'webhooks.endpoints': limit([1, 2, 10, 50, null, 3]),
} as const satisfies Record<string, EntitlementDef>;
