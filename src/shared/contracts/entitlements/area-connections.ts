import {
  ADMIT_CONNECTORS,
  ALL,
  allow,
  type EntitlementDef,
  limit,
  NONE,
  STUB_CONNECTORS,
} from './kinds.ts';

export const AREA_CONNECTIONS = {
  connections: limit([1, 2, 3, 15, 40, null, null, 0]),
  connectors: allow([STUB_CONNECTORS, ADMIT_CONNECTORS, ALL, ALL, ALL, ALL, ALL, NONE]),
} as const satisfies Record<string, EntitlementDef>;
