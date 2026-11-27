import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import type { WalletHealth } from '@/shared/contracts/wallet-health.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture } from '@/web/lib/test-utils.tsx';
import { enrolment, renderOrgAccounts } from './wallet-accounts-test-fixtures.ts';

const OPERATE: OrgCapability[] = [
  'org:read',
  'integrations:read',
  'integrations:manage',
  'passes:operate',
];
const member = (capabilities: OrgCapability[]) =>
  membershipFixture('o1', { orgName: 'North', capabilities });

const health = (over: Partial<WalletHealth> = {}): WalletHealth => ({
  provider: 'google',
  mode: 'test',
  tone: 'ok',
  lastSuccessAt: Date.UTC(2026, 10, 24, 22, 15),
  queued: 0,
  failed24h: 0,
  uncertain: 0,
  uncertainWaiting: 0,
  callbackAt: null,
  ...over,
});

function handlers(items: WalletHealth[], onRecheck?: (url: URL) => unknown) {
  return {
    '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
    '/api/v1/orgs/o1/wallet-enrolments': () =>
      json({
        items: [enrolment({ state: 'on', source: 'platform' }), enrolment({ provider: 'samsung' })],
        nextCursor: null,
      }),
    '/api/v1/orgs/o1/wallet-credentials': () => json({ items: [], nextCursor: null }),
    '/api/v1/orgs/o1/wallet-health': () => json({ items }),
    '/api/v1/orgs/o1/wallet-health/google/recheck': (u: URL) => {
      onRecheck?.(u);
      return json({ queued: 2, waiting: 0 }, 202);
    },
  };
}

beforeEach(() => {
  resetModeForTests();
  setMode('test');
});
afterEach(() => resetModeForTests());

describe('wallet health', () => {
  it('shows the counts and a calm pill when all is well, with no axe violations', async () => {
    const { container } = await renderOrgAccounts({
      memberships: [member(OPERATE)],
      handlers: handlers([health({ queued: 3 })]),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    const panel = await within(google).findByRole('region', { name: 'Health' });
    expect(within(panel).getByText('Healthy')).toBeInTheDocument();
    expect(within(panel).getByText('Queued').nextElementSibling).toHaveTextContent('3');
    expect(within(panel).queryByRole('button', { name: 'Check again' })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('has no panel for a wallet the server leaves out', async () => {
    await renderOrgAccounts({ memberships: [member(OPERATE)], handlers: handlers([]) });
    const samsung = await screen.findByRole('region', { name: 'Samsung Wallet' });
    await screen.findByRole('region', { name: 'Google Wallet' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Health' })).toBeNull());
    expect(within(samsung).queryByText('Healthy')).toBeNull();
  });

  it('offers Check again for updates past the grace window and posts it', async () => {
    const user = userEvent.setup();
    const posts: URL[] = [];
    const { container } = await renderOrgAccounts({
      memberships: [member(OPERATE)],
      handlers: handlers([health({ tone: 'attention', uncertain: 2, uncertainWaiting: 0 })], (u) =>
        posts.push(u),
      ),
    });
    const panel = await screen.findByRole('region', { name: 'Health' });
    expect(within(panel).getByText('Needs attention')).toBeInTheDocument();
    expect(within(panel).getByText('2 updates have an unknown outcome')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((await axe(container)).violations).toEqual([]);
  });

  it('disables Check again while every update is inside the window', async () => {
    await renderOrgAccounts({
      memberships: [member(OPERATE)],
      handlers: handlers([health({ tone: 'attention', uncertain: 1, uncertainWaiting: 1 })]),
    });
    const panel = await screen.findByRole('region', { name: 'Health' });
    expect(within(panel).getByRole('button', { name: 'Check again' })).toBeDisabled();
    expect(within(panel).getByText('Settles by itself within 10 minutes.')).toBeInTheDocument();
  });

  it('hides Check again without passes:operate', async () => {
    await renderOrgAccounts({
      memberships: [member(['org:read', 'integrations:read'])],
      handlers: handlers([health({ tone: 'attention', uncertain: 1, uncertainWaiting: 0 })]),
    });
    const panel = await screen.findByRole('region', { name: 'Health' });
    expect(within(panel).queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('says plainly that the credentials are failing', async () => {
    await renderOrgAccounts({
      memberships: [member(OPERATE)],
      handlers: handlers([health({ tone: 'failing' })]),
    });
    const panel = await screen.findByRole('region', { name: 'Health' });
    expect(within(panel).getByText('Credentials failing')).toBeInTheDocument();
    expect(
      within(panel).getByText('The provider refused the credentials twice. Rotate them.'),
    ).toBeInTheDocument();
  });
});
