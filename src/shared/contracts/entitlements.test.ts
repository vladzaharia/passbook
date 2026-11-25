import { describe, expect, it } from 'vitest';
import { entitlementImpact } from '../entitlement-impact.ts';
import {
  ENTITLEMENT_KEYS,
  ENTITLEMENT_PRESETS,
  ENTITLEMENTS,
  type EntitlementKey,
  entitledValue,
  entitlementDef,
  levelsAtLeast,
  listMatches,
  parseEntitlementValue,
  presetValues,
  withinLimitValue,
} from './entitlements.ts';
import { CreateOrgSchema, UpdateOrgSchema } from './orgs.ts';

describe('entitlement registry', () => {
  it('every preset carries every key with a valid value', () => {
    for (const preset of ENTITLEMENT_PRESETS) {
      const values = presetValues(preset);
      expect(Object.keys(values).sort()).toEqual([...ENTITLEMENT_KEYS].sort());
      for (const key of ENTITLEMENT_KEYS)
        expect(parseEntitlementValue(key, values[key]), `${preset} ${key}`).toBeDefined();
    }
  });

  it('Unlimited is every flag on, no limits, footer can be off', () => {
    const legacy = presetValues('legacy');
    for (const key of ENTITLEMENT_KEYS) {
      const def = entitlementDef(key);
      if (def.kind === 'flag') expect(legacy[key], key).toBe(1);
      if (def.kind === 'limit') expect(legacy[key], key).toBeNull();
    }
    expect(legacy['brand.mark']).toBe('none');
    expect(legacy.connectors).toEqual(['*']);
    expect(legacy['templates.stylesBlocked']).toEqual([]);
  });

  it('lists the plans in card order, with the developer sandbox last', () => {
    expect(ENTITLEMENT_PRESETS).toEqual([
      'trial',
      'starter',
      'standard',
      'premium',
      'legacy',
      'developer',
    ]);
  });

  it('every step up the ladder only adds: nothing turns off, drops or changes sideways', () => {
    const ladder = ['trial', 'starter', 'standard', 'premium', 'legacy'] as const;
    for (const [i, higher] of ladder.entries()) {
      const lower = ladder[i - 1];
      if (!lower) continue;
      const { counts } = entitlementImpact(presetValues(lower), presetValues(higher));
      expect({
        step: `${lower} -> ${higher}`,
        off: counts.off,
        down: counts.down,
        changed: counts.changed,
      }).toEqual({ step: `${lower} -> ${higher}`, off: 0, down: 0, changed: 0 });
    }
  });

  it('levels run lowest to highest and include the ones below', () => {
    expect(levelsAtLeast('api', 'read')).toEqual(['read', 'full']);
    expect(levelsAtLeast('api', 'bogus')).toEqual([]);
    expect(levelsAtLeast('api.keys', 'read')).toEqual([]);
  });

  it('rejects values of the wrong shape for the key', () => {
    const bad: [EntitlementKey, unknown][] = [
      ['apps', true],
      ['apps', 2],
      ['apps', null],
      ['api', 'huge'],
      ['api', null],
      ['connectors', 'all'],
      ['connectors', ['a b']],
      ['connectors', [1]],
      ['members', -1],
      ['members', 1.5],
      ['members', '5'],
      ['members', undefined],
    ];
    for (const [key, raw] of bad) expect(parseEntitlementValue(key, raw), `${key}`).toBeUndefined();
    expect(parseEntitlementValue('members', null)).toBeNull();
    expect(parseEntitlementValue('members', 0)).toBe(0);
  });

  it('fails closed: a missing or invalid value denies', () => {
    expect(entitledValue('apps', undefined)).toBe(false);
    expect(entitledValue('apps', 0)).toBe(false);
    expect(entitledValue('apps', 1)).toBe(true);
    expect(entitledValue('apps', null as never)).toBe(false);
    expect(entitledValue('api', 'full')).toBe(false);
    expect(entitledValue('api', 'bogus', 'read')).toBe(false);
    expect(entitledValue('api', 'full', 'read')).toBe(true);
    expect(entitledValue('api', 'read', 'full')).toBe(false);
    expect(withinLimitValue(undefined, 0)).toBe(false);
    expect(withinLimitValue('5' as never, 0)).toBe(false);
  });

  it('a limit is a cap, null has none, 0 is off', () => {
    expect(withinLimitValue(null, 1e9)).toBe(true);
    expect(withinLimitValue(3, 2)).toBe(true);
    expect(withinLimitValue(3, 3)).toBe(false);
    expect(withinLimitValue(0, 0)).toBe(false);
    expect(entitledValue('connections', 0)).toBe(false);
    expect(entitledValue('connections', 1)).toBe(true);
    expect(entitledValue('connections', null)).toBe(true);
  });

  it('matches list entries by item, type wildcard and star', () => {
    expect(listMatches('webhook-push/shopify')).toEqual([
      '*',
      'webhook-push/shopify',
      'webhook-push/*',
      'webhook-push',
    ]);
    expect(entitledValue('connectors', ['*'], 'anything')).toBe(true);
    expect(entitledValue('connectors', ['webhook-push/*'], 'webhook-push/shopify')).toBe(true);
    expect(entitledValue('connectors', ['webhook-push/*'], 'webhook-push')).toBe(true);
    expect(entitledValue('connectors', ['csv-url'], 'csv-url/x')).toBe(true);
    expect(entitledValue('connectors', ['csv-url'], 'webhook-push/x')).toBe(false);
    expect(entitledValue('connectors', [], 'csv-url')).toBe(false);
    expect(entitledValue('connectors', ['*'])).toBe(false);
  });

  it('a block-list on a type also blocks its recipes, and a pattern is never an item', () => {
    expect(entitledValue('templates.stylesBlocked', ['shopify'], 'shopify/orders')).toBe(false);
    expect(entitledValue('templates.stylesBlocked', [], '*')).toBe(false);
    expect(entitledValue('connectors', ['*'], 'a/*')).toBe(false);
  });

  it('a block-list refuses what it names', () => {
    expect(entitledValue('templates.stylesBlocked', ['boardingPass'], 'boardingPass')).toBe(false);
    expect(entitledValue('templates.stylesBlocked', ['boardingPass'], 'coupon')).toBe(true);
    expect(entitledValue('templates.stylesBlocked', [], 'boardingPass')).toBe(true);
    expect(entitledValue('templates.stylesBlocked', undefined, 'coupon')).toBe(false);
  });

  it('keys are unique dotted names', () => {
    expect(new Set(ENTITLEMENT_KEYS).size).toBe(ENTITLEMENT_KEYS.length);
    for (const key of Object.keys(ENTITLEMENTS)) expect(key).toMatch(/^[a-z]+(\.[a-zA-Z]+)?$/);
  });
});

describe('preset on org create', () => {
  const base = { slug: 'acme', name: 'Acme' };
  it('takes a preset, optional', () => {
    expect(CreateOrgSchema.parse(base).preset).toBeUndefined();
    expect(CreateOrgSchema.parse({ ...base, preset: 'trial' }).preset).toBe('trial');
    expect(CreateOrgSchema.safeParse({ ...base, preset: 'gold' }).success).toBe(false);
  });
  it('an update cannot carry one', () => {
    expect(UpdateOrgSchema.parse({ preset: 'legacy', name: 'X' })).toEqual({ name: 'X' });
  });
});
