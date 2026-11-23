import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_KEYS,
  ENTITLEMENT_PRESETS,
  entitlementDef,
} from '../contracts/entitlements.ts';
import {
  ENTITLEMENT_LABEL,
  ENTITLEMENT_LEVEL_LABEL,
  FEATURES_LABEL,
  featureNotIncluded,
  limitReached,
  PRESET_LABEL,
} from './entitlements.ts';

describe('entitlement copy', () => {
  it('labels exactly the registry keys, presets and levels', () => {
    expect(Object.keys(ENTITLEMENT_LABEL).sort()).toEqual([...ENTITLEMENT_KEYS].sort());
    expect(Object.keys(PRESET_LABEL).sort()).toEqual([...ENTITLEMENT_PRESETS].sort());
    const levelKeys = ENTITLEMENT_KEYS.filter((k) => entitlementDef(k).kind === 'level');
    expect(Object.keys(ENTITLEMENT_LEVEL_LABEL).sort()).toEqual([...levelKeys].sort());
    for (const key of levelKeys) {
      const def = entitlementDef(key);
      if (def.kind === 'level')
        expect(Object.keys(ENTITLEMENT_LEVEL_LABEL[key] ?? {}).sort(), key).toEqual(
          [...def.levels].sort(),
        );
    }
  });

  it('names Unlimited for the legacy id', () => {
    expect(PRESET_LABEL.legacy).toBe('Unlimited');
    expect(ENTITLEMENT_LABEL['brand.mark']).toBe('PassBook footer');
  });

  it('has a non-empty, distinct label per key', () => {
    const labels = Object.values(ENTITLEMENT_LABEL);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('words a refusal in one sentence plus what to do', () => {
    expect(FEATURES_LABEL).toBe('Features');
    expect(featureNotIncluded('webhooks')).toBe(
      "Webhooks isn't included for this organization. Ask PassBook to turn it on.",
    );
    expect(limitReached('templates')).toBe(
      'Templates: limit reached for this organization. Ask PassBook for more.',
    );
  });
});
