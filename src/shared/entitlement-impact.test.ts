import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_KEYS, presetValues } from './contracts/entitlements.ts';
import { type EntitlementValues, entitlementImpact, reducing } from './entitlement-impact.ts';

const kinds = (before: EntitlementValues, after: EntitlementValues) =>
  Object.fromEntries(entitlementImpact(before, after).changes.map((c) => [c.key, c.kind]));

describe('entitlementImpact', () => {
  it('reads each kind of value from the org side', () => {
    expect(kinds({ print: 1 }, { print: 0 })).toEqual({ print: 'off' });
    expect(kinds({ print: 0 }, { print: 1 })).toEqual({ print: 'on' });
    expect(kinds({ api: 'full' }, { api: 'read' })).toEqual({ api: 'down' });
    expect(kinds({ api: 'read' }, { api: 'off' })).toEqual({ api: 'off' });
    expect(kinds({ nfc: 'off' }, { nfc: 'basic' })).toEqual({ nfc: 'on' });
    expect(kinds({ 'passes.live': null }, { 'passes.live': 100 })).toEqual({
      'passes.live': 'down',
    });
    expect(kinds({ 'passes.live': 100 }, { 'passes.live': 5000 })).toEqual({
      'passes.live': 'up',
    });
    expect(kinds({ 'passes.live': 100 }, { 'passes.live': null })).toEqual({ 'passes.live': 'up' });
    expect(kinds({ domains: 1 }, { domains: 0 })).toEqual({ domains: 'off' });
    expect(kinds({ domains: 0 }, { domains: 2 })).toEqual({ domains: 'on' });
  });

  it('reads lists by whether the org gets more or less of them', () => {
    expect(kinds({ connectors: ['*'] }, { connectors: ['csv-url'] })).toEqual({
      connectors: 'down',
    });
    expect(kinds({ connectors: ['csv-url'] }, { connectors: ['csv-url', 'x/*'] })).toEqual({
      connectors: 'up',
    });
    expect(kinds({ connectors: ['a'] }, { connectors: ['b'] })).toEqual({ connectors: 'changed' });
    // A block-list that grows blocks more.
    expect(
      kinds({ 'templates.stylesBlocked': [] }, { 'templates.stylesBlocked': ['boardingPass'] }),
    ).toEqual({ 'templates.stylesBlocked': 'down' });
  });

  it('reads less of the PassBook mark as more for the org', () => {
    expect(kinds({ 'brand.mark': 'full' }, { 'brand.mark': 'quiet' })).toEqual({
      'brand.mark': 'up',
    });
    expect(kinds({ 'brand.mark': 'none' }, { 'brand.mark': 'full' })).toEqual({
      'brand.mark': 'down',
    });
  });

  it('counts legacy to trial and back, and ignores features that do not move', () => {
    const legacy = presetValues('legacy');
    const trial = presetValues('trial');
    const down = entitlementImpact(legacy, trial);
    expect(down.counts.off).toBeGreaterThan(0);
    expect(down.counts.down).toBeGreaterThan(0);
    expect(reducing(down)).toBe(down.counts.off + down.counts.down);
    const total = Object.values(down.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(ENTITLEMENT_KEYS.length);
    const same = entitlementImpact(legacy, legacy);
    expect(same.changes).toEqual([]);
    expect(same.counts.unchanged).toBe(ENTITLEMENT_KEYS.length);
  });

  it('treats a missing value as off, since it denies', () => {
    expect(kinds({ print: 1 }, {})).toEqual({ print: 'off' });
    expect(kinds({}, { print: 1 })).toEqual({ print: 'on' });
  });
});
