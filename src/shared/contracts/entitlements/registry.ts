import { z } from 'zod';
import { AREA_ACCOUNT } from './area-account.ts';
import { AREA_API } from './area-api.ts';
import { AREA_AUDIT } from './area-audit.ts';
import { AREA_BRAND } from './area-brand.ts';
import { AREA_BUNDLES } from './area-bundles.ts';
import { AREA_CONNECTIONS } from './area-connections.ts';
import { AREA_CORE } from './area-core.ts';
import { AREA_IDENTITY } from './area-identity.ts';
import { AREA_MESSAGES } from './area-messages.ts';
import { AREA_NFC } from './area-nfc.ts';
import { AREA_PASSES } from './area-passes.ts';
import { AREA_SCAN_CONSOLE } from './area-scan-console.ts';
import { AREA_SCAN_DOOR } from './area-scan-door.ts';
import { AREA_TEAM } from './area-team.ts';
import type { EntitlementDef, EntitlementValue } from './kinds.ts';
import type { EntitlementPreset } from './presets.ts';

/**
 * Columns: trial, starter, standard, premium, unlimited (id `legacy`), developer. Unlimited is every flag
 * on and no limits, so nothing changes for an existing org. Each step up only adds (a test holds it).
 */
export const ENTITLEMENTS = {
  ...AREA_CORE,
  ...AREA_BRAND,
  ...AREA_AUDIT,
  ...AREA_ACCOUNT,
  ...AREA_PASSES,
  ...AREA_MESSAGES,
  ...AREA_SCAN_CONSOLE,
  ...AREA_SCAN_DOOR,
  ...AREA_NFC,
  ...AREA_TEAM,
  ...AREA_API,
  ...AREA_IDENTITY,
  ...AREA_BUNDLES,
  ...AREA_CONNECTIONS,
} as const satisfies Record<string, EntitlementDef>;

export type EntitlementKey = keyof typeof ENTITLEMENTS;
export const ENTITLEMENT_KEYS = Object.keys(ENTITLEMENTS) as EntitlementKey[];
export const EntitlementKeySchema = z.enum(
  ENTITLEMENT_KEYS as [EntitlementKey, ...EntitlementKey[]],
);

export const entitlementDef = (key: EntitlementKey): EntitlementDef => ENTITLEMENTS[key];

/** The preset as data: every key, in registry order. */
export const presetValues = (preset: EntitlementPreset): Record<EntitlementKey, EntitlementValue> =>
  Object.fromEntries(
    ENTITLEMENT_KEYS.map((key) => [key, entitlementDef(key).presets[preset]]),
  ) as Record<EntitlementKey, EntitlementValue>;

const ENTRY =
  /^(?:\*|[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/(?:\*|[A-Za-z0-9][A-Za-z0-9_.-]{0,63}))?)$/;

/** The typed value, or undefined when `raw` is not valid for the key (which denies). */
export function parseEntitlementValue(
  key: EntitlementKey,
  raw: unknown,
): EntitlementValue | undefined {
  const def = entitlementDef(key);
  switch (def.kind) {
    case 'flag':
      return raw === 0 || raw === 1 ? raw : undefined;
    case 'level':
      return typeof raw === 'string' && def.levels.includes(raw) ? raw : undefined;
    case 'list':
      return Array.isArray(raw) &&
        raw.length <= 64 &&
        raw.every((e) => typeof e === 'string' && ENTRY.test(e))
        ? (raw as string[])
        : undefined;
    case 'limit':
      return raw === null || (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0)
        ? raw
        : undefined;
  }
}

/** The stored text of a valid value, as the migration seeds it. */
export const entitlementJson = (value: EntitlementValue): string => JSON.stringify(value);

/** Levels that satisfy "at least `min`" (a level includes the ones below it). Empty for an unknown level. */
export function levelsAtLeast(key: EntitlementKey, min: string): string[] {
  const def = entitlementDef(key);
  if (def.kind !== 'level') return [];
  const at = def.levels.indexOf(min);
  return at < 0 ? [] : def.levels.slice(at);
}

/**
 * The list entries that match `item` (`type` or `type/recipe`): `*`, the item, `type/*` and the bare `type`,
 * so listing a type covers its recipes, and blocking a type blocks them.
 */
export function listMatches(item: string): string[] {
  const type = item.split('/')[0] ?? item;
  return [...new Set(['*', item, `${type}/*`, type])];
}

/** Whether `used` more fits under a limit value. `null` has no cap; anything not a count denies. */
export const withinLimitValue = (value: EntitlementValue | undefined, used: number): boolean =>
  value === null || (typeof value === 'number' && used < value);

/**
 * The decision for one stored value. Fail closed: undefined (no row) and invalid values deny.
 * `want` is the minimum level (level), the item (list) and ignored for a flag or a limit; a limit is on
 * unless it is 0.
 */
export function entitledValue(
  key: EntitlementKey,
  value: EntitlementValue | undefined,
  want?: string,
): boolean {
  const def = entitlementDef(key);
  if (value === undefined || parseEntitlementValue(key, value) === undefined) return false;
  switch (def.kind) {
    case 'flag':
      return value === 1;
    case 'level':
      return want !== undefined && levelsAtLeast(key, want).includes(value as string);
    case 'list': {
      if (want === undefined || want.includes('*')) return false;
      const hit = listMatches(want).some((m) => (value as string[]).includes(m));
      return def.block ? !hit : hit;
    }
    case 'limit':
      return value === null || (value as number) > 0;
  }
}
