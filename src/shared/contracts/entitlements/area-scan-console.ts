import { type EntitlementDef, limit } from './kinds.ts';

export const AREA_SCAN_CONSOLE = {
  'scanning.devices': limit([1, 5, 10, 50, 100, null, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
