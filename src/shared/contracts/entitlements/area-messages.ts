import { type EntitlementDef, limit } from './kinds.ts';

export const AREA_MESSAGES = {
  'messages.perDay': limit([3, 5, 20, 100, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
