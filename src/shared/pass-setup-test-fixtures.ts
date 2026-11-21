import { levelState } from './channels.ts';
import {
  CHANNELS,
  type Channel,
  type ChannelLevel,
  type ChannelReason,
  type EffectiveChannels,
} from './contracts/channels.ts';
import type { WalletIdentityDto } from './contracts/identities.ts';
import type { PassSetup, SetupChannel, SetupTemplate } from './contracts/pass-setup.ts';
import type { WalletEnrolment } from './contracts/wallet-providers.ts';
import { orgSetupChecks, type SetupFacts } from './org-setup-checks.ts';

export const NOW = Date.UTC(2026, 10, 21);
const DAY = 86_400_000;
const SHA = 'a'.repeat(64);

/** An org chain: `stop` stops it at that level; every other level is ok. */
export function chainOf(
  stop?: { level: 'passbook' | 'plan' | 'org'; reason: ChannelReason },
  templates: 'ok' | 'partial' | 'off' = 'ok',
): ChannelLevel[] {
  const upper = (['passbook', 'plan', 'org'] as const).map((level) => {
    const reason = stop?.level === level ? stop.reason : undefined;
    return {
      level,
      state: levelState(level, reason),
      ...(reason ? { reason } : {}),
      canChange: level === 'org',
    };
  });
  return [...upper, { level: 'template', state: templates, canChange: true }];
}

export function channelOf(
  stop?: { level: 'passbook' | 'plan' | 'org'; reason: ChannelReason },
  over: Partial<SetupChannel> = {},
): SetupChannel {
  return {
    on: !stop,
    allowed: !(stop?.level === 'org' && stop.reason !== 'not_enrolled'),
    levels: chainOf(stop),
    templates: { on: 2, off: 0, never: 0, total: 2 },
    ...over,
  };
}

export function enrolmentOf(
  provider: 'google' | 'samsung',
  over: Partial<WalletEnrolment> = {},
): WalletEnrolment {
  return {
    mode: 'live',
    provider,
    accountId: null,
    source: null,
    platformAvailable: false,
    state: 'absent',
    enrolmentRevision: 0,
    prerequisites: { check: false, roundTrip: false },
    hold: null,
    issuance: { state: 'disabled', reason: 'not_released' },
    ...over,
  };
}

export function identityOf(over: Partial<WalletIdentityDto> = {}): WalletIdentityDto {
  return {
    id: 'idn_1',
    provider: 'apple',
    orgId: 'org_1',
    label: 'Acme Fitness',
    identifier: 'pass.mobile.passbook.acmefitness',
    kind: 'managed',
    status: 'active',
    notBefore: NOW - 30 * DAY,
    notAfter: NOW + 300 * DAY,
    rotation: 'auto',
    nextRotationAt: NOW + 270 * DAY,
    issuing: true,
    isDefault: true,
    passCount: 375,
    createdAt: NOW - 30 * DAY,
    ...over,
  };
}

const allOn = (): EffectiveChannels =>
  Object.fromEntries(
    CHANNELS.map((c) => [c, { on: true, source: 'template' }]),
  ) as EffectiveChannels;

export function templateOf(id: string, over: Partial<SetupTemplate> = {}): SetupTemplate {
  return { id, name: id, ownBrand: [], placeholders: [], channels: allOn(), ...over };
}

const org = <T>(value: T) => ({ value, source: 'org' as const });

/** A set-up org: own brand, support, a managed Apple ID; Google and Samsung dark, paper not in the plan. */
export function readyFacts(): SetupFacts {
  const channels = Object.fromEntries(CHANNELS.map((c) => [c, channelOf()])) as Record<
    Channel,
    SetupChannel
  >;
  for (const p of ['google', 'samsung'] as const)
    channels[p] = channelOf(
      { level: 'passbook', reason: 'not_released' },
      { account: enrolmentOf(p) },
    );
  channels.paper = channelOf({ level: 'plan', reason: 'not_included' });
  return {
    orgId: 'org_1',
    mode: 'live',
    revision: 'r1',
    passCount: 412,
    brand: {
      name: org('Acme Fitness'),
      logo: { ...org({ sha: SHA, w: 480, h: 150 }), templatesOwn: 0 },
      icon: { ...org({ sha: SHA, w: 114, h: 114 }), templatesOwn: 0 },
      webLogo: { value: null, source: 'passbook', sameAsLogo: true },
      passColors: {
        ...org({ background: '#0f172a', foreground: '#ffffff', label: '#fbbf24' }),
        templatesOwn: 0,
      },
      logoHasName: org(false),
      accent: org('#2563eb'),
      mark: { chosen: 'full', effective: 'full', allowed: ['full', 'small'] },
      support: { email: org('help@acme.test'), url: { value: null, source: 'passbook' } },
      email: { fromName: { value: 'Acme Fitness via PassBook', source: 'passbook' }, buddy: false },
    },
    channels,
    apple: {
      identity: identityOf(),
      sharedIdentifier: 'pass.mobile.passbook.wallet',
      push: 'healthy',
      run: null,
      managedAllowed: true,
      passesOnShared: 37,
    },
    templates: [templateOf('tpl_gym'), templateOf('tpl_day')],
  };
}

/** A new org: placeholders everywhere, signing with the shared ID (B2). */
export function newOrgFacts(): SetupFacts {
  const f = readyFacts();
  const none = { value: null, source: 'passbook' as const, templatesOwn: 0 };
  return {
    ...f,
    passCount: 0,
    brand: {
      ...f.brand,
      logo: none,
      icon: none,
      passColors: none,
      accent: { value: null, source: 'passbook' },
      support: {
        email: { value: null, source: 'passbook' },
        url: { value: null, source: 'passbook' },
      },
    },
    apple: { ...f.apple, identity: null, passesOnShared: 0 },
    templates: [templateOf('tpl_gym', { placeholders: ['logo', 'icon'] })],
  };
}

/** The full view as GET answers it. */
export const viewOf = (f: SetupFacts, now = NOW): PassSetup => ({
  ...f,
  checks: orgSetupChecks(f, now),
});
