import type { EntitlementItemDto } from '@/shared/contracts/entitlement-admin.ts';
import {
  type EntitlementKey,
  type EntitlementValue,
  entitlementDef,
} from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LEVEL_LABEL } from '@/shared/copy/entitlements.ts';
import type { EntitlementValues } from '@/shared/entitlement-impact.ts';
import { formatCount } from '@/web/lib/format.ts';

/** The Features tab's sections; every registry key is in exactly one (a test holds it). */
export const FEATURE_GROUPS: readonly { title: string; keys: readonly EntitlementKey[] }[] = [
  { title: 'API and apps', keys: ['api', 'api.rateTier', 'api.keys', 'apps'] },
  { title: 'Integrations', keys: ['webhooks', 'webhooks.endpoints', 'connections', 'connectors'] },
  {
    title: 'Wallets and delivery',
    keys: ['wallet.google', 'wallet.samsung', 'print', 'nfc', 'scanning.devices'],
  },
  {
    title: 'Passes and people',
    keys: [
      'passes.live',
      'passes.test',
      'templates',
      'templates.uploads',
      'templates.stylesBlocked',
      'join.perDay',
      'messages.perDay',
      'passes.changesPerDay',
      'email.perDay',
      'members',
      'members.developers',
    ],
  },
  {
    title: 'Brand and identity',
    keys: ['brand.mark', 'domains', 'identity.own', 'identity.managed'],
  },
];

/** How a value reads: On and Off, a level's name, a count or No limit, a list's entries. */
export function formatValue(key: EntitlementKey, value: EntitlementValue | undefined): string {
  if (value === undefined) return 'Off';
  const def = entitlementDef(key);
  switch (def.kind) {
    case 'flag':
      return value === 1 ? 'On' : 'Off';
    case 'level':
      return ENTITLEMENT_LEVEL_LABEL[key]?.[String(value)] ?? String(value);
    case 'limit':
      return value === null ? 'No limit' : value === 0 ? 'Off' : formatCount(Number(value));
    case 'list': {
      const entries = value as string[];
      if (entries.length === 0) return 'None';
      return entries.includes('*') ? (def.block ? 'All' : 'Any') : entries.join(', ');
    }
  }
}

/** A value that stops the feature reads muted. */
export const isOff = (key: EntitlementKey, value: EntitlementValue | undefined): boolean => {
  const def = entitlementDef(key);
  if (value === undefined) return true;
  if (def.kind === 'flag') return value === 0;
  if (def.kind === 'limit') return value === 0;
  if (def.kind === 'level') return def.levels[0] === 'off' && value === 'off';
  return false;
};

export const valuesOf = (items: readonly EntitlementItemDto[]): EntitlementValues =>
  Object.fromEntries(items.map((i) => [i.key, i.value])) as EntitlementValues;

/** The override a row would send: value, note and expiry. */
export interface OverrideDraft {
  value: EntitlementValue;
  note: string | null;
  expiresAt: number | null;
}

export type OverrideMap = Partial<Record<EntitlementKey, OverrideDraft>>;

export const overridesOf = (items: readonly EntitlementItemDto[]): OverrideMap =>
  Object.fromEntries(
    items
      .filter((i) => i.source === 'override')
      .map((i) => [i.key, { value: i.value, note: i.note, expiresAt: i.expiresAt }]),
  );

/** The values after a preset (its own values) and a set of overrides: an override wins where the preset has the key. */
export function resolved(
  presetValues: EntitlementValues,
  overrides: OverrideMap,
): EntitlementValues {
  const out: EntitlementValues = {};
  for (const key of Object.keys(presetValues) as EntitlementKey[]) {
    const base = presetValues[key];
    if (base !== undefined) out[key] = overrides[key]?.value ?? base;
  }
  return out;
}
