import { describe, expect, it } from 'vitest';
import {
  blockedByEntitlement,
  type ChannelInputs,
  channelTransition,
  effectiveChannels,
  entitlementTransition,
} from './channels.ts';
import { type EntitlementPreset, presetValues } from './contracts/entitlements.ts';

const base: ChannelInputs = {
  platform: {},
  org: {},
  capability: {},
  template: null,
  pass: {},
  retired: {},
};
const eff = (over: Partial<ChannelInputs> = {}) => effectiveChannels({ ...base, ...over });
const notIncluded = { on: false, source: 'platform', reason: 'not_included' } as const;
const blocked = (preset: EntitlementPreset) => blockedByEntitlement(presetValues(preset));

describe('the plan level of the resolver', () => {
  it('turns a channel off with reason not_included, reported as a platform-level refusal', () => {
    const e = eff({ entitlement: { google: 'not_included', nfc: 'not_included' } });
    expect(e.google).toEqual(notIncluded);
    expect(e.nfc).toEqual(notIncluded);
    expect(e.apple).toEqual({ on: true, source: 'template' });
  });

  it('sits after the platform and before the org, capability, template and pass levels', () => {
    const all = {
      platform: { google: 'not_released' },
      entitlement: { google: 'not_included' },
      org: { google: 'blocked' },
      capability: { google: 'no_design' },
      template: { google: 'never' },
      pass: { google: 'on' },
    } as const;
    expect(eff(all).google.reason).toBe('not_released');
    expect(eff({ ...all, platform: {} }).google.reason).toBe('not_included');
    expect(eff({ ...all, platform: {}, entitlement: {} }).google.reason).toBe('blocked');
  });

  it('cannot be lifted by a template default, a policy or a pass override', () => {
    const entitlement = { paper: 'not_included' } as const;
    expect(eff({ entitlement, defaults: { paper: 'on' } }).paper).toEqual(notIncluded);
    expect(eff({ entitlement, template: { paper: 'on' } }).paper).toEqual(notIncluded);
    expect(eff({ entitlement, pass: { paper: 'on' } }).paper).toEqual(notIncluded);
  });

  it('is absent for an input that names no entitlement: nothing changes', () => {
    expect(eff({ entitlement: undefined })).toEqual(eff({ entitlement: {} }));
  });
});

describe('blockedByEntitlement', () => {
  it('blocks nothing on legacy and standard, and every plan-gated channel on trial', () => {
    expect(blocked('legacy')).toEqual({});
    expect(blocked('standard')).toEqual({});
    expect(blocked('trial')).toEqual({
      samsung: 'not_included',
      paper: 'not_included',
      nfc: 'not_included',
    });
  });

  it('reads each feature: one wallet, print and the NFC level', () => {
    const on = presetValues('legacy');
    expect(blockedByEntitlement({ ...on, 'wallet.samsung': 0 })).toEqual({
      samsung: 'not_included',
    });
    expect(blockedByEntitlement({ ...on, print: 0 })).toEqual({ paper: 'not_included' });
    expect(blockedByEntitlement({ ...on, nfc: 'off' })).toEqual({ nfc: 'not_included' });
    expect(blockedByEntitlement({ ...on, nfc: 'basic' })).toEqual({});
    expect(blockedByEntitlement({ ...on, nfc: 'secure' })).toEqual({});
  });

  it('fails closed: a missing or invalid value blocks', () => {
    expect(Object.keys(blockedByEntitlement({}))).toEqual(['google', 'samsung', 'paper', 'nfc']);
    const on = presetValues('legacy');
    expect(blockedByEntitlement({ ...on, print: 7 })).toEqual({ paper: 'not_included' });
    expect(blockedByEntitlement({ ...on, nfc: 'gold' })).toEqual({ nfc: 'not_included' });
  });
});

describe('entitlementTransition', () => {
  const legacy = presetValues('legacy');
  const trial = presetValues('trial');

  it('asks for one channel-apply of the channels whose plan state changed', () => {
    expect(entitlementTransition(legacy, trial)).toEqual([
      {
        kind: 'channel_apply',
        channels: ['samsung', 'paper', 'nfc'],
        blockedBefore: [],
        blockedAfter: ['samsung', 'paper', 'nfc'],
      },
    ]);
    expect(entitlementTransition(trial, legacy)).toEqual([
      {
        kind: 'channel_apply',
        channels: ['samsung', 'paper', 'nfc'],
        blockedBefore: ['samsung', 'paper', 'nfc'],
        blockedAfter: [],
      },
    ]);
    expect(entitlementTransition(legacy, { ...legacy, print: 0 })).toEqual([
      { kind: 'channel_apply', channels: ['paper'], blockedBefore: [], blockedAfter: ['paper'] },
    ]);
  });

  it('asks for nothing when no channel changes: a level move inside the plan, an unrelated key', () => {
    expect(entitlementTransition(legacy, legacy)).toEqual([]);
    expect(entitlementTransition(legacy, { ...legacy, nfc: 'basic' })).toEqual([]);
    expect(entitlementTransition(legacy, { ...legacy, webhooks: 0, 'api.keys': 2 })).toEqual([]);
  });
});

describe('a plan change is a kill switch', () => {
  const on = eff({ pass: { paper: 'on' } });
  const off = eff({
    pass: { paper: 'on' },
    entitlement: { google: 'not_included', paper: 'not_included' },
  });

  it('never retires, voids or rotates on a downgrade, and restores nothing it never retired', () => {
    expect(channelTransition(on, off, { copies: new Set(['google', 'apple']) })).toEqual([]);
    expect(channelTransition(off, on, { copies: new Set(['google', 'apple']) })).toEqual([]);
  });

  it('restores a copy that a plain turn-off retired before the plan lifted', () => {
    expect(channelTransition(off, on, { retired: new Set(['google']) })).toEqual([
      { kind: 'restore', channel: 'google', warn: false },
    ]);
  });
});
