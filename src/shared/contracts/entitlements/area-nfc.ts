import { type EntitlementDef, level } from './kinds.ts';

export const AREA_NFC = {
  nfc: level(
    ['off', 'basic', 'secure'],
    ['off', 'basic', 'basic', 'basic', 'secure', 'secure', 'secure', 'off'],
  ),
} as const satisfies Record<string, EntitlementDef>;
