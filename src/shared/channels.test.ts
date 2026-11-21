import { describe, expect, it } from 'vitest';
import {
  type ChannelInputs,
  chainLevelOf,
  channelTransition,
  effectiveChannels,
  levelState,
  nothingOn,
  stoppingLevel,
  templateDefault,
} from './channels.ts';
import type { EffectiveChannels } from './contracts/channels.ts';

const base: ChannelInputs = {
  platform: {},
  org: {},
  capability: {},
  template: null,
  pass: {},
  retired: {},
};
const eff = (over: Partial<ChannelInputs> = {}) => effectiveChannels({ ...base, ...over });

describe('manifest defaults', () => {
  it('stand where the policy is silent, below the policy and the pass', () => {
    const defaults = { paper: 'on', nfc: 'off' } as const;
    expect(eff({ defaults }).paper).toEqual({ on: true, source: 'template' });
    expect(eff({ defaults }).nfc).toEqual({
      on: false,
      source: 'template',
      reason: 'template_off',
    });
    expect(eff({ defaults, template: { paper: 'off' } }).paper.on).toBe(false);
    expect(eff({ defaults, template: { nfc: 'on' } }).nfc.on).toBe(true);
    expect(eff({ defaults, pass: { nfc: 'on' } }).nfc).toEqual({ on: true, source: 'pass' });
    expect(eff({ defaults, template: { paper: 'never' } }).paper.reason).toBe('never');
  });

  it('never lift a platform or org block', () => {
    const e = eff({ defaults: { paper: 'on' }, platform: { paper: 'printing_off' } });
    expect(e.paper).toEqual({ on: false, source: 'platform', reason: 'printing_off' });
  });
});

describe('effectiveChannels precedence', () => {
  it('defaults: digital on, paper off, nfc on', () => {
    const e = eff();
    expect(['mobile', 'apple', 'google', 'samsung'].map((c) => e[c as 'apple'].on)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(e.paper).toEqual({ on: false, source: 'template', reason: 'template_off' });
    expect(e.nfc.on).toBe(true);
    expect(templateDefault('nfc')).toBe('on');
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
    expect(eff({ pass: { apple: 'off' }, retired: { apple: 5 } }).apple.retiredAt).toBe(5);
    // An on channel never reads retired.
    expect(eff({ retired: { apple: 5 } }).apple).toEqual({ on: true, source: 'template' });
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

  it('replace codes also covers channels retired earlier, e.g. re-enabling after all were off', () => {
    const allOff = { mobile: 'off', apple: 'off', google: 'off', samsung: 'off' } as const;
    const retired = { mobile: 1, apple: 1, google: 1, samsung: 1 };
    const before = on({ pass: allOff, retired });
    const after = on({ pass: { apple: 'off', google: 'off', samsung: 'off' }, retired });
    const actions = channelTransition(before, after, {
      replaceCodes: true,
      copies: new Set(['apple', 'samsung']),
      retired: new Set(['mobile', 'apple', 'google', 'samsung']),
    });
    expect(actions).toContainEqual({ kind: 'restore', channel: 'mobile', warn: false });
    expect(actions).toContainEqual({ kind: 'rotate_codes', channels: ['apple', 'samsung'] });
  });

  it('a set of channels limits what replace codes covers', () => {
    const after = on({ pass: { apple: 'off', google: 'off' } });
    const actions = channelTransition(on(), after, {
      replaceCodes: new Set(['apple']),
      copies: new Set(['apple', 'google']),
    });
    expect(actions.filter((a) => a.kind === 'rotate_codes')).toEqual([
      { kind: 'rotate_codes', channels: ['apple'] },
    ]);
  });

  it('never rotates a channel that is on, or one without a copy', () => {
    const after = on({ pass: { apple: 'off' } });
    const none = channelTransition(on(), after, {
      replaceCodes: true,
      copies: new Set(['google']),
    });
    expect(none.some((a) => a.kind === 'rotate_codes')).toBe(false);
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

  it('block, then template off, then unblock retires with copy evidence', () => {
    const blocked = on({ org: { apple: 'blocked' } });
    const lifted = on({ template: { apple: 'off' } });
    expect(channelTransition(on(), blocked, { copies: new Set(['apple']) })).toEqual([]);
    expect(
      channelTransition(blocked, on({ org: { apple: 'blocked' }, template: { apple: 'off' } }), {
        copies: new Set(['apple']),
      }),
    ).toEqual([]);
    expect(channelTransition(blocked, lifted, { copies: new Set(['apple']) })).toEqual([
      { kind: 'retire', channel: 'apple' },
    ]);
    // Without a copy there is nothing to retire; already retired stays as is.
    expect(channelTransition(blocked, lifted)).toEqual([]);
    expect(
      channelTransition(blocked, lifted, {
        copies: new Set(['apple']),
        retired: new Set(['apple']),
      }),
    ).toEqual([]);
  });

  it('block, pass reset while blocked, then unblock restores a retired channel', () => {
    const blocked = on({
      org: { apple: 'blocked' },
      pass: { apple: 'off' },
      retired: { apple: 3 },
    });
    const after = on({ retired: { apple: 3 } });
    expect(after.apple).toEqual({ on: true, source: 'template' });
    expect(channelTransition(blocked, after, { retired: new Set(['apple']) })).toEqual([
      { kind: 'restore', channel: 'apple', warn: false },
    ]);
  });
});

describe('offer holds', () => {
  it('has contract values and copy for each hold', async () => {
    const { OFFER_HOLDS } = await import('./contracts/channels.ts');
    const { offerHold, OFFER_HOLD_COPY } = await import('./copy/channels.ts');
    expect(Object.keys(OFFER_HOLD_COPY).sort()).toEqual([...OFFER_HOLDS].sort());
    expect(offerHold('google', 'provider_retiring')).toBe(
      'Google Wallet: the old copy is being removed. Try again shortly.',
    );
    expect(offerHold('samsung', 'provider_epoch_limit')).toContain('Samsung Wallet');
  });
});

describe('the chain', () => {
  it('names an entitlement refusal Plan while its source stays platform', () => {
    const e = eff({ entitlement: { paper: 'not_included' }, platform: { nfc: 'tags_off' } });
    expect(e.paper.source).toBe('platform');
    expect(chainLevelOf(e.paper.source, e.paper.reason)).toBe('plan');
    expect(chainLevelOf(e.nfc.source, e.nfc.reason)).toBe('passbook');
    expect(chainLevelOf('org', 'blocked')).toBe('org');
    expect(chainLevelOf('pass', 'pass_off')).toBe('pass');
  });

  it.each([
    ['passbook', 'not_released', 'locked'],
    ['plan', 'not_included', 'locked'],
    ['org', 'not_enrolled', 'needs'],
    ['org', 'blocked', 'off'],
    ['template', 'never', 'off'],
    ['pass', 'pass_off', 'off'],
    ['org', undefined, 'ok'],
  ] as const)('%s %s reads %s', (level, reason, state) => {
    expect(levelState(level, reason)).toBe(state);
  });

  it('stops at the first level that is not ok or partial', () => {
    const at = (
      level: 'passbook' | 'org' | 'template',
      state: 'ok' | 'partial' | 'off' | 'locked',
    ) => ({ level, state, canChange: false }) as const;
    expect(stoppingLevel([at('passbook', 'ok'), at('template', 'partial')])).toBeNull();
    expect(stoppingLevel([at('passbook', 'locked'), at('org', 'off')])?.level).toBe('passbook');
  });
});
