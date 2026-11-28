import { type EntitlementDef, flag } from './kinds.ts';

export const AREA_IDENTITY = {
  'identity.own': flag([0, 0, 0, 1, 1, 1, 1, 0]),
  'identity.managed': flag([0, 0, 1, 0, 1, 1, 1, 0]),
} as const satisfies Record<string, EntitlementDef>;
