import { type EntitlementDef, flag, limit } from './kinds.ts';

export const AREA_PASSES = {
  print: flag([0, 1, 1, 1, 1, 0]),
  'join.perDay': limit([100, 250, 1000, 10000, null, 0]),
  'passes.changesPerDay': limit([3, 5, 20, 100, null, 10]),
  'passes.live': limit([100, 1000, 5000, 50000, null, 0]),
  'passes.test': limit([50, 200, 500, 2000, null, 500]),
} as const satisfies Record<string, EntitlementDef>;
