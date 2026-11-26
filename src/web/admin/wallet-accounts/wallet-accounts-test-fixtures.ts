import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  PlatformWalletEnrolment,
  WalletCredential,
  WalletEnrolment,
} from '@/shared/contracts/wallet-providers.ts';
import type { WalletRelease, WalletReleaseMode } from '@/shared/contracts/wallet-release.ts';
import { channelOf, enrolmentOf, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { json, type RenderAppOptions, renderApp } from '@/web/lib/test-utils.tsx';

export const KEY = '-----BEGIN PRIVATE KEY-----\nU0VDUkVUX0tFWQ==\n-----END PRIVATE KEY-----';

export const enrolment = (over: Partial<WalletEnrolment> = {}): WalletEnrolment => ({
  mode: 'test',
  provider: 'google',
  accountId: null,
  source: null,
  platformAvailable: true,
  state: 'absent',
  enrolmentRevision: 0,
  prerequisites: { check: false, roundTrip: null },
  hold: null,
  issuance: { state: 'disabled', reason: 'not_released' },
  ...over,
});

export const credential = (over: Partial<WalletCredential> = {}): WalletCredential => ({
  id: 'c1',
  scope: 'org',
  orgId: 'o1',
  mode: 'test',
  provider: 'google',
  identityHint: '4321',
  cardTypes: [],
  lastCheck: null,
  provenance: 'own',
  revision: 1,
  verifiedAt: null,
  revokedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...over,
});

export const platformEnrolment = (
  over: Partial<PlatformWalletEnrolment> = {},
): PlatformWalletEnrolment => ({
  orgId: 'o1',
  orgName: 'North',
  mode: 'live',
  provider: 'google',
  source: 'platform',
  state: 'on',
  hold: null,
  updatedAt: 1_700_000_000_000,
  ...over,
});

/** Both wallets released for the org, so the Channels card shows their account cards. */
function releasedSetup() {
  const f = readyFacts();
  for (const p of ['google', 'samsung'] as const)
    f.channels[p] = channelOf(undefined, { account: enrolmentOf(p) });
  return viewOf(f);
}

/** The org's wallet accounts now live in the Google and Samsung rows of Brand and channels. */
export async function renderOrgAccounts(options: RenderAppOptions) {
  const user = userEvent.setup();
  const rendered = await renderApp('/admin/o/o1/brand', {
    ...options,
    handlers: {
      '/api/v1/orgs/o1/pass-setup': () => json(releasedSetup()),
      ...options.handlers,
    },
  });
  for (const name of ['Google Wallet', 'Samsung Wallet']) {
    const row = await screen.findByRole('button', { name: new RegExp(`^${name}`) });
    await user.click(row);
  }
  return rendered;
}

const DARK = { state: 'disabled', reason: 'not_released' } as const;
const OPEN = { state: 'enabled' } as const;

/** Release state as the platform credential list reports it; both modes dark unless named. */
export const walletRelease = (test: boolean = false, live: boolean = false): WalletRelease => {
  const by = { live: live ? OPEN : DARK, test: test ? OPEN : DARK };
  return { google: by, samsung: by };
};

/** One provider in one mode, as GET /platform/wallet-release reports it. */
export const releaseMode = (over: Partial<WalletReleaseMode> = {}): WalletReleaseMode => ({
  provider: 'google',
  mode: 'live',
  state: 'dark',
  credentials: [
    credential({
      scope: 'platform',
      orgId: null,
      mode: 'live',
      lastCheck: { ok: true, code: null, at: Date.now() - 60_000 },
    }),
  ],
  enrolments: [
    { orgId: 'o1', orgName: 'North', status: 'issuing', blocks: [] },
    { orgId: 'o2', orgName: 'Acme', status: 'ready', blocks: [] },
    { orgId: 'o3', orgName: 'Birch', status: 'ready', blocks: [] },
    { orgId: 'o4', orgName: 'Cedar', status: 'blocked', blocks: ['check', 'hold'] },
  ],
  templates: { ready: 4, withOmissions: 2, awaitingReview: 1, none: 3 },
  instances: { open: 7, retired: 2 },
  ...over,
});

/** Both modes of one provider, plus the other provider dark, so a tab must pick its own. */
export const releaseReport = (
  provider: 'google' | 'samsung',
  state: WalletReleaseMode['state'],
  over: Partial<WalletReleaseMode> = {},
) => ({
  releases: [
    releaseMode({ provider, mode: 'live', state, ...over }),
    releaseMode({ provider, mode: 'test', state, ...over }),
    releaseMode({ provider: provider === 'google' ? 'samsung' : 'google', mode: 'live' }),
  ],
});
