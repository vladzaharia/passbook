import { z } from 'zod';

/**
 * What an organization may use (entitlements, "Features" in the UI), as opposed to what a role may do
 * (`OrgCapability`). One registry holds every key; presets are columns of it, so a preset that forgets a key
 * does not compile. The migration seeds `entitlement_presets` from it and a test holds the two equal.
 *
 * Values are stored as JSON text. A missing or malformed value denies; JSON `null` means "no limit" and is
 * valid for a limit only.
 */
export const ENTITLEMENT_PRESETS = ['legacy', 'trial', 'standard'] as const;
export const EntitlementPresetSchema = z.enum(ENTITLEMENT_PRESETS);
export type EntitlementPreset = z.infer<typeof EntitlementPresetSchema>;

/** 1 on, 0 off. */
type FlagValue = 0 | 1;
/** `null` is no limit; `0` is off. */
type LimitValue = number | null;
export type EntitlementValue = FlagValue | LimitValue | string | string[];
type Column<V> = Record<EntitlementPreset, V>;

export type EntitlementDef =
  | { kind: 'flag'; presets: Column<FlagValue> }
  /** `levels` runs lowest to highest; a level includes every level below it. */
  | { kind: 'level'; levels: readonly string[]; presets: Column<string> }
  /** An allow-list (`block` false) or a block-list; entries are `*`, `type`, `type/recipe` or `type/*`. */
  | { kind: 'list'; block: boolean; presets: Column<string[]> }
  | { kind: 'limit'; presets: Column<LimitValue> };

const col = <V>(legacy: V, trial: V, standard: V): Column<V> => ({ legacy, trial, standard });
const flag = (legacy: FlagValue, trial: FlagValue, standard: FlagValue): EntitlementDef => ({
  kind: 'flag',
  presets: col(legacy, trial, standard),
});
const level = (levels: readonly string[], l: string, t: string, s: string): EntitlementDef => ({
  kind: 'level',
  levels,
  presets: col(l, t, s),
});
const allow = (l: string[], t: string[], s: string[]): EntitlementDef => ({
  kind: 'list',
  block: false,
  presets: col(l, t, s),
});
const block = (l: string[], t: string[], s: string[]): EntitlementDef => ({
  kind: 'list',
  block: true,
  presets: col(l, t, s),
});
const limit = (l: LimitValue, t: LimitValue, s: LimitValue): EntitlementDef => ({
  kind: 'limit',
  presets: col(l, t, s),
});

/** Presets read legacy, trial, standard. `legacy` is every flag on and no limits: nothing changes for existing orgs. */
export const ENTITLEMENTS = {
  api: level(['off', 'read', 'full'], 'full', 'full', 'full'),
  'api.rateTier': level(['standard', 'high', 'bulk'], 'bulk', 'standard', 'high'),
  'api.keys': limit(null, 2, 10),
  apps: flag(1, 0, 1),
  webhooks: flag(1, 0, 1),
  'webhooks.endpoints': limit(null, 1, 10),
  connections: limit(null, 1, 10),
  connectors: allow(['*'], ['csv-url', 'webhook-push/*'], ['*']),
  'wallet.google': flag(1, 0, 1),
  'wallet.samsung': flag(1, 0, 1),
  print: flag(1, 0, 1),
  nfc: level(['off', 'basic', 'secure'], 'secure', 'off', 'basic'),
  'scanning.devices': limit(null, 2, 20),
  'join.perDay': limit(null, 100, 1000),
  'messages.perDay': limit(null, 3, 20),
  'passes.live': limit(null, 100, 5000),
  'passes.test': limit(null, 50, 500),
  templates: limit(null, 3, 25),
  'templates.uploads': flag(1, 0, 1),
  'templates.stylesBlocked': block([], ['boardingPass'], []),
  'email.perDay': limit(null, 100, 500),
  members: limit(null, 3, 25),
  'brand.mark': level(['none', 'quiet', 'full'], 'full', 'full', 'quiet'),
  domains: limit(0, 0, 1),
  'identity.own': flag(1, 0, 1),
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
 * The list entries that match `item` (`type` or `type/recipe`): `*`, the item, and `type/*`. A block-list
 * also matches the bare `type`, so blocking a type blocks its recipes.
 */
export function listMatches(item: string, blockList = false): string[] {
  const type = item.split('/')[0] ?? item;
  return ['*', item, `${type}/*`, ...(blockList ? [type] : [])];
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
      const hit = listMatches(want, def.block).some((m) => (value as string[]).includes(m));
      return def.block ? !hit : hit;
    }
    case 'limit':
      return value === null || (value as number) > 0;
  }
}
