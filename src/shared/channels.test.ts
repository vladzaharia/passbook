import { describe, expect, it } from 'vitest';
import {
  type ChannelInputs,
  channelTransition,
  effectiveChannels,
  nothingOn,
  templateDefault,
} from './channels.ts';
import type { EffectiveChannels } from './contracts/channels.ts';

const base: ChannelInputs = {
  platform: {},
  org: {},
  capability: {},
  template: null,
  scanTags: false,
  pass: {},
  retired: {},
};
const eff = (over: Partial<ChannelInputs> = {}) => effectiveChannels({ ...base, ...over });

describe('effectiveChannels precedence', () => {
  it('defaults: digital on, paper off, nfc on only with scan.tags', () => {
    const e = eff();
    expect(['mobile', 'apple', 'google', 'samsung'].map((c) => e[c as 'apple'].on)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(e.paper).toEqual({ on: false, source: 'template', reason: 'template_off' });
    expect(e.nfc.on).toBe(false);
    expect(eff({ scanTags: true }).nfc.on).toBe(true);
    expect(templateDefault('nfc', true)).toBe('on');
  });

  it('the first failing level is the reason: platform, org, capability, never, pass, template', () => {
    const all = {
      platform: { apple: 'not_released' },
      org: { apple: 'blocked' },
      capability: { apple: 'no_design' },
      template: { apple: 'never' },
      pass: { apple: 'on' },
    } as const;
    expect(eff(all).apple).toEqual({ on: false, source: 'platform', reason: 'not_released' });
    expect(eff({ ...all, platform: {} }).apple).toEqual({
      on: false,
      source: 'org',
      reason: 'blocked',
    });
    expect(eff({ ...all, platform: {}, org: {} }).apple).toEqual({
      on: false,
      source: 'template',
      reason: 'no_design',
    });
    expect(eff({ ...all, platform: {}, org: {}, capability: {} }).apple).toEqual({
      on: false,
      source: 'template',
      reason: 'never',
    });
  });

  it('a pass turns on what its template has off, never what is never or blocked', () => {
    expect(eff({ template: { paper: 'off' }, pass: { paper: 'on' } }).paper).toEqual({
      on: true,
      source: 'pass',
    });
    expect(eff({ template: { paper: 'never' }, pass: { paper: 'on' } }).paper.on).toBe(false);
    expect(eff({ org: { paper: 'blocked' }, pass: { paper: 'on' } }).paper.on).toBe(false);
  });

  it('a pass turns off what its template has on', () => {
    expect(eff({ pass: { apple: 'off' } }).apple).toEqual({
      on: false,
      source: 'pass',
      reason: 'pass_off',
    });
  });

  it('reports retiredAt and nothingOn', () => {
    expect(eff({ retired: { apple: 5 } }).apple.retiredAt).toBe(5);
    const off = { mobile: 'x', apple: 'x', google: 'x', samsung: 'x', paper: 'x', nfc: 'x' };
    const e = eff({ org: Object.fromEntries(Object.keys(off).map((k) => [k, 'blocked'])) });
    expect(nothingOn(e)).toBe(true);
  });
});

describe('channelTransition', () => {
  const on = (over: Partial<ChannelInputs> = {}): EffectiveChannels => eff(over);

  it('a plain off retires and never rotates', () => {
    const actions = channelTransition(on(), on({ pass: { apple: 'off' } }), {
      copies: new Set(['apple']),
    });
    expect(actions).toEqual([{ kind: 'retire', channel: 'apple' }]);
  });

  it('replace codes rotates only with copy evidence and a digital channel left on', () => {
    const after = on({ pass: { apple: 'off' } });
    expect(
      channelTransition(on(), after, { replaceCodes: true, copies: new Set(['apple']) }),
    ).toEqual([
      { kind: 'retire', channel: 'apple' },
      { kind: 'rotate_codes', channels: ['apple'] },
    ]);
    expect(channelTransition(on(), after, { replaceCodes: true })).toEqual([
      { kind: 'retire', channel: 'apple' },
    ]);
    const allOff = on({ pass: { mobile: 'off', apple: 'off', google: 'off', samsung: 'off' } });
    expect(
      channelTransition(on(), allOff, { replaceCodes: true, copies: new Set(['apple']) }).some(
        (a) => a.kind === 'rotate_codes',
      ),
    ).toBe(false);
  });

  it('a kill switch never retires or rotates', () => {
    const blocked = on({ org: { apple: 'blocked' } });
    expect(
      channelTransition(on(), blocked, { replaceCodes: true, copies: new Set(['apple']) }),
    ).toEqual([]);
    expect(channelTransition(on(), on({ platform: { apple: 'not_released' } }))).toEqual([]);
  });

  it('paper off voids prints; paper rotation is never asked for', () => {
    const before = on({ pass: { paper: 'on' }, platform: {} });
    const after = on({ pass: { paper: 'off' } });
    expect(channelTransition(before, after, { replaceCodes: true })).toEqual([
      { kind: 'void_prints' },
    ]);
  });

  it('turning a retired channel back on restores it, warning when copies exist', () => {
    const before = on({ pass: { apple: 'off' }, retired: { apple: 1 } });
    const after = on({ retired: { apple: 1 } });
    expect(channelTransition(before, after, { retired: new Set(['apple']) })).toEqual([
      { kind: 'restore', channel: 'apple', warn: false },
    ]);
    expect(
      channelTransition(before, after, {
        retired: new Set(['apple']),
        copies: new Set(['apple']),
      }),
    ).toEqual([{ kind: 'restore', channel: 'apple', warn: true }]);
  });
});
