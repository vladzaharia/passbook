import { type EntitlementDef, limit } from './kinds.ts';

export const AREA_MESSAGES = {
  'messages.perDay': limit([1, 5, 10, 25, 50, null, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
