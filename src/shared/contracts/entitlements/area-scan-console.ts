import { type EntitlementDef, limit } from './kinds.ts';

export const AREA_SCAN_CONSOLE = {
  'scanning.devices': limit([2, 5, 20, 100, null, 0]),
} as const satisfies Record<string, EntitlementDef>;
