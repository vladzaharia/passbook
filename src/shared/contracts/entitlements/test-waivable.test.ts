import { describe, expect, it } from 'vitest';
import type { EntitlementValue } from './kinds.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  entitledValue,
  entitlementDef,
  presetValues,
} from './registry.ts';
import {
  isTestWaivable,
  NOT_TEST_WAIVABLE,
  TEST_WAIVABLE,
  valuesInMode,
  WAIVED_KEYS,
} from './test-waivable.ts';

const ORG_WIDE = [
  'audit.export',
  'roles.advanced',
  'api.ipAllow',
  'brand.mark',
  'identity.own',
  'identity.managed',
  'account.orgs',
  'account.orgApi',
  'account.staging',
  'org.restricted',
  'passes.issuePaused',
  'templates.uploads',
  'connectors',
  'nfc',
  'nfc.lending',
  'nfc.wallet',
];

describe('Test-mode waiver classification', () => {
  it('classifies every registry key exactly once', () => {
    const unclassified = ENTITLEMENT_KEYS.filter(
      (key) => TEST_WAIVABLE.includes(key) === NOT_TEST_WAIVABLE.includes(key),
    );
    expect(unclassified).toEqual([]);
  });

  it('keeps the two lists disjoint and free of repeats', () => {
    const all = [...TEST_WAIVABLE, ...NOT_TEST_WAIVABLE];
    expect(new Set(all).size).toBe(all.length);
  });

  it('never waives a limit', () => {
    const limits = ENTITLEMENT_KEYS.filter((key) => entitlementDef(key).kind === 'limit');
    expect(limits.filter(isTestWaivable)).toEqual([]);
  });

  it('never waives an org-wide or billing key', () => {
    for (const key of ORG_WIDE) {
      expect(NOT_TEST_WAIVABLE, key).toContain(key);
      expect(isTestWaivable(key), key).toBe(false);
    }
    const orgWide = /^(identity|account)\.|^(billing|audit)/;
    expect(TEST_WAIVABLE.filter((key) => orgWide.test(key))).toEqual([]);
  });
});

describe('valuesInMode', () => {
  const trial = presetValues('trial');

  it('leaves Live as stored', () => {
    expect(valuesInMode(trial, 'live')).toBe(trial);
  });

  it('turns every waived key full in Test and leaves the rest', () => {
    const test = valuesInMode(trial, 'test');
    expect(entitledValue('print', test.print)).toBe(true);
    expect(test.nfc).toEqual(trial.nfc);
    expect(test.connectors).toEqual(trial.connectors);
    expect(entitledValue('templates.stylesBlocked', test['templates.stylesBlocked'], 'x')).toBe(
      true,
    );
    for (const key of ENTITLEMENT_KEYS.filter((k) => !WAIVED_KEYS.includes(k)))
      expect(test[key], key).toEqual(trial[key]);
  });

  it('waives nothing the org has no row for', () => {
    const none: Partial<Record<EntitlementKey, EntitlementValue>> = {};
    expect(valuesInMode(none, 'test')).toEqual({});
    expect(valuesInMode({ print: 0 }, 'test')).toEqual({ print: 1 });
  });
});
