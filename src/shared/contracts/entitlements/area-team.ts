import { type EntitlementDef, limit } from './kinds.ts';

export const AREA_TEAM = {
  members: limit([3, 5, 25, 100, null, 1]),
  'members.developers': limit([1, 2, 5, 25, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
