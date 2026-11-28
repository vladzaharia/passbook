import { BOARDING, block, type EntitlementDef, flag, limit, NONE } from './kinds.ts';

export const AREA_CORE = {
  templates: limit([2, 5, 10, 100, 500, null, null, 10]),
  'templates.uploads': flag([0, 0, 1, 1, 1, 1, 1, 0]),
  'templates.stylesBlocked': block([BOARDING, NONE, NONE, NONE, NONE, NONE, NONE, NONE]),
  'wallet.google': flag([1, 1, 1, 1, 1, 1, 1, 0]),
  'wallet.samsung': flag([0, 0, 1, 1, 1, 1, 1, 0]),
  'email.perDay': limit([35, 1700, 5000, 10000, 50000, null, null, 100]),
} as const satisfies Record<string, EntitlementDef>;
