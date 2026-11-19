import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

const own = {
  id: 'i-own',
  orgId: 'o1',
  label: 'North signing',
  passTypeIdentifier: 'pass.com.north',
  teamIdentifier: 'TEAM123',
  source: 'db',
  certSha256: 'ab',
  certSubject: null,
  certSerial: null,
  notBefore: 1_600_000_000_000,
  notAfter: Date.now() + 100 * 86_400_000,
  daysRemaining: 100,
  apnsBinding: null,
  apnsAvailable: true,
  pushMethod: 'certificate',
  pushKey: null,
  apnsHealth: 'healthy',
  nfcEnabled: false,
  isDefault: false,
  createdAt: 1_600_000_000_000,
};
const account = (url: URL) =>
  json({
    orgId: 'o1',
    mode: url.searchParams.get('mode'),
    provider: url.searchParams.get('provider'),
    accountId: null,
    revision: 0,
    state: 'absent',
    externalApprovalVerified: false,
    issuance: { state: 'disabled', reason: 'not_released' },
    updatedAt: null,
  });
const north = membershipFixture('o1', { orgName: 'North' });

describe('wallet accounts per scope', () => {
  it('shows an organization its own Apple identity and its Google and Samsung accounts', async () => {
    const { fetchMock } = await renderApp('/admin/o/o1/wallet-accounts', {
      session: 'user',
      memberships: [north],
      handlers: {
        '/api/v1/identities': () => json({ items: [own], nextCursor: null }),
        '/api/v1/wallet-providers/accounts': account,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Wallet accounts', level: 1 })).toBeVisible();
    expect(await screen.findByText('North signing')).toBeInTheDocument();
    const calls = fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
    const identities = calls.filter((url) => url.pathname === '/api/v1/identities');
    expect(identities.length).toBeGreaterThan(0);
    expect(identities.every((url) => url.searchParams.get('orgId') === 'o1')).toBe(true);
    await waitFor(() => {
      const providers = calls.filter((url) => url.pathname === '/api/v1/wallet-providers/accounts');
      expect(providers.length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Platform-wide/)).toBeNull();
  });

  it('says an organization without its own identity signs with the platform identity', async () => {
    await renderApp('/admin/o/o1/wallet-accounts', {
      session: 'user',
      memberships: [north],
      handlers: {
        '/api/v1/identities': () => json({ items: [], nextCursor: null }),
        '/api/v1/wallet-providers/accounts': account,
      },
    });
    expect(await screen.findByText("Signs with PassBook's identity.")).toBeInTheDocument();
  });

  it('lists every identity on the platform page, which names no scope in its labels', async () => {
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        '/api/v1/identities': () =>
          json({
            items: [own, { ...own, id: 'i-2', label: 'Platform', orgId: null }],
            nextCursor: null,
          }),
        '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Wallet accounts', level: 1 })).toBeVisible();
    expect(await screen.findByText('North signing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Platform' })).toBeInTheDocument();
    expect(screen.queryByText(/Platform-wide/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Google Wallet' })).toBeNull();
  });
});

describe('members per scope', () => {
  it('shows the Members page to a member who can manage members', async () => {
    await renderApp('/admin/o/o1/members', {
      session: 'user',
      memberships: [north],
      handlers: {
        '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
        '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
    expect(await screen.findByText('No active members.')).toBeInTheDocument();
  });

  it('refuses the Members page without members:manage and makes no member request', async () => {
    const { fetchMock } = await renderApp('/admin/o/o1/members', {
      session: 'user',
      memberships: [
        membershipFixture('o1', { capabilities: ['org:read', 'passes:read', 'integrations:read'] }),
      ],
    });
    expect(
      await screen.findByRole('heading', { name: /You do not have access|does not include/ }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/orgs/o1/'))).toBe(false);
    expect(within(document.body).queryByText('No active members.')).toBeNull();
  });
});
