import { ALL, allow, BASIC_CONNECTORS, type EntitlementDef, limit, NONE } from './kinds.ts';

export const AREA_CONNECTIONS = {
  connections: limit([1, 2, 10, 50, null, 0]),
  connectors: allow([BASIC_CONNECTORS, BASIC_CONNECTORS, ALL, ALL, ALL, NONE]),
} as const satisfies Record<string, EntitlementDef>;
