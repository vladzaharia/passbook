import { type EntitlementDef, limit } from './kinds.ts';

export const AREA_TEAM = {
  members: limit([2, 5, 8, 40, 250, null, null, 1]),
  'members.developers': limit([1, 2, 3, 8, 25, null, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
