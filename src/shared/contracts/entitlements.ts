import { z } from 'zod';

/**
 * What an organization may use (entitlements, "Features" in the UI), as opposed to what a role may do
 * (`OrgCapability`). One registry holds every key; presets are columns of it, so a preset that forgets a key
 * does not compile. The migration seeds `entitlement_presets` from it and a test holds the two equal.
 *
 * Values are stored as JSON text. A missing or malformed value denies; JSON `null` means "no limit" and is
 * valid for a limit only.
 */
export const ENTITLEMENT_PRESETS = [
  'trial',
  'starter',
  'standard',
  'premium',
  'legacy',
  'developer',
] as const;
export const EntitlementPresetSchema = z.enum(ENTITLEMENT_PRESETS);
export type EntitlementPreset = z.infer<typeof EntitlementPresetSchema>;

/** Orders preset ids as the registry lists them (the ladder); an id it does not know sorts last, then by id. */
export function presetOrder(a: string, b: string): number {
  const rank = (id: string) => {
    const at = (ENTITLEMENT_PRESETS as readonly string[]).indexOf(id);
    return at < 0 ? ENTITLEMENT_PRESETS.length : at;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

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

/** Column order of every row below, and the order the picker lists plans. */
type Row<V> = readonly [trial: V, starter: V, standard: V, premium: V, unlimited: V, developer: V];
const col = <V>([trial, starter, standard, premium, legacy, developer]: Row<V>): Column<V> => ({
  trial,
  starter,
  standard,
  premium,
  legacy,
  developer,
});
const flag = (r: Row<FlagValue>): EntitlementDef => ({ kind: 'flag', presets: col(r) });
const level = (levels: readonly string[], r: Row<string>): EntitlementDef => ({
  kind: 'level',
  levels,
  presets: col(r),
});
const allow = (r: Row<string[]>): EntitlementDef => ({
  kind: 'list',
  block: false,
  presets: col(r),
});
const block = (r: Row<string[]>): EntitlementDef => ({
  kind: 'list',
  block: true,
  presets: col(r),
});
const limit = (r: Row<LimitValue>): EntitlementDef => ({ kind: 'limit', presets: col(r) });

const BASIC_CONNECTORS: string[] = ['csv-url', 'webhook-push/*', 'file-upload', 'demo'];
const ALL: string[] = ['*'];
const BOARDING: string[] = ['boardingPass'];
const NONE: string[] = [];

/**
 * Columns: trial, starter, standard, premium, unlimited (id `legacy`), developer. Unlimited is every flag
 * on and no limits, so nothing changes for an existing org. Each step up only adds (a test holds it).
 */
export const ENTITLEMENTS = {
  api: level(['off', 'read', 'full'], ['full', 'full', 'full', 'full', 'full', 'full']),
  'api.rateTier': level(
    ['standard', 'high', 'bulk'],
    ['standard', 'standard', 'high', 'bulk', 'bulk', 'standard'],
  ),
  'api.keys': limit([2, 3, 10, 50, null, 3]),
  apps: flag([0, 0, 1, 1, 1, 0]),
  webhooks: flag([0, 1, 1, 1, 1, 1]),
  'webhooks.endpoints': limit([1, 2, 10, 50, null, 3]),
  connections: limit([1, 2, 10, 50, null, 0]),
  connectors: allow([BASIC_CONNECTORS, BASIC_CONNECTORS, ALL, ALL, ALL, NONE]),
  'wallet.google': flag([0, 1, 1, 1, 1, 0]),
  'wallet.samsung': flag([0, 0, 1, 1, 1, 0]),
  print: flag([0, 1, 1, 1, 1, 0]),
  nfc: level(['off', 'basic', 'secure'], ['off', 'off', 'basic', 'secure', 'secure', 'off']),
  'scanning.devices': limit([2, 5, 20, 100, null, 0]),
  'join.perDay': limit([100, 250, 1000, 10000, null, 0]),
  'messages.perDay': limit([3, 5, 20, 100, null, 0]),
  'passes.changesPerDay': limit([3, 5, 20, 100, null, 10]),
  'passes.live': limit([100, 1000, 5000, 50000, null, 0]),
  'passes.test': limit([50, 200, 500, 2000, null, 500]),
  templates: limit([3, 5, 25, 100, null, 10]),
  'templates.uploads': flag([0, 0, 1, 1, 1, 0]),
  'templates.stylesBlocked': block([BOARDING, BOARDING, NONE, NONE, NONE, NONE]),
  'email.perDay': limit([100, 250, 500, 5000, null, 100]),
  members: limit([3, 5, 25, 100, null, 1]),
  'brand.mark': level(['none', 'quiet', 'full'], ['full', 'full', 'quiet', 'none', 'none', 'full']),
  domains: limit([0, 0, 1, 5, null, 0]),
  'identity.own': flag([0, 0, 1, 1, 1, 0]),
  'identity.managed': flag([0, 0, 1, 1, 1, 0]),
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
