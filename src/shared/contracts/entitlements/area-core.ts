import { BOARDING, block, type EntitlementDef, flag, limit, NONE } from './kinds.ts';

export const AREA_CORE = {
  templates: limit([3, 5, 25, 100, null, 10]),
  'templates.uploads': flag([0, 0, 1, 1, 1, 0]),
  'templates.stylesBlocked': block([BOARDING, BOARDING, NONE, NONE, NONE, NONE]),
  'wallet.google': flag([0, 1, 1, 1, 1, 0]),
  'wallet.samsung': flag([0, 0, 1, 1, 1, 0]),
  'email.perDay': limit([100, 250, 500, 5000, null, 100]),
} as const satisfies Record<string, EntitlementDef>;
