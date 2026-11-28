import { type EntitlementDef, flag, limit } from './kinds.ts';

export const AREA_PASSES = {
  print: flag([0, 1, 1, 1, 1, 1, 1, 0]),
  'join.perDay': limit([10, 150, 1500, 3000, 7500, null, null, 0]),
  'passes.changesPerDay': limit([1, 3, 8, 20, 50, null, null, 10]),
  'passes.live': limit([50, null, null, null, null, null, null, 0]),
  'passes.test': limit([50, 100, 250, 500, 1000, null, null, 500]),
} as const satisfies Record<string, EntitlementDef>;
