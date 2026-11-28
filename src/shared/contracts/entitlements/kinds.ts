import type { EntitlementPreset } from './presets.ts';

/** 1 on, 0 off. */
export type FlagValue = 0 | 1;
/** `null` is no limit; `0` is off. */
export type LimitValue = number | null;
export type EntitlementValue = FlagValue | LimitValue | string | string[];
export type Column<V> = Record<EntitlementPreset, V>;

export type EntitlementDef =
  | { kind: 'flag'; presets: Column<FlagValue> }
  /** `levels` runs lowest to highest; a level includes every level below it. */
  | { kind: 'level'; levels: readonly string[]; presets: Column<string> }
  /** An allow-list (`block` false) or a block-list; entries are `*`, `type`, `type/recipe` or `type/*`. */
  | { kind: 'list'; block: boolean; presets: Column<string[]> }
  | { kind: 'limit'; presets: Column<LimitValue> };

/** Column order of every row below, and the order the picker lists plans. */
export type Row<V> = readonly [
  trial: V,
  starter: V,
  standard: V,
  business: V,
  premium: V,
  enterprise: V,
  unlimited: V,
  developer: V,
];
export const col = <V>([
  trial,
  starter,
  standard,
  business,
  premium,
  enterprise,
  legacy,
  developer,
]: Row<V>): Column<V> => ({
  trial,
  starter,
  standard,
  business,
  premium,
  enterprise,
  legacy,
  developer,
});
export const flag = (r: Row<FlagValue>): EntitlementDef => ({ kind: 'flag', presets: col(r) });
export const level = (levels: readonly string[], r: Row<string>): EntitlementDef => ({
  kind: 'level',
  levels,
  presets: col(r),
});
export const allow = (r: Row<string[]>): EntitlementDef => ({
  kind: 'list',
  block: false,
  presets: col(r),
});
export const block = (r: Row<string[]>): EntitlementDef => ({
  kind: 'list',
  block: true,
  presets: col(r),
});
export const limit = (r: Row<LimitValue>): EntitlementDef => ({ kind: 'limit', presets: col(r) });

export const STUB_CONNECTORS: string[] = ['csv-url', 'file-upload', 'demo'];
export const ADMIT_CONNECTORS: string[] = [
  ...STUB_CONNECTORS,
  'http-json',
  'webhook-push/*',
  'zapier',
  'shopify/webhook',
  'stripe/*',
  'woocommerce/*',
  'calcom/*',
  'tickettailor/*',
];
export const ALL: string[] = ['*'];
export const BOARDING: string[] = ['boardingPass'];
export const NONE: string[] = [];
