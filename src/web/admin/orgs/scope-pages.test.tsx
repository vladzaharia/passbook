import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

const own = {
  id: 'i-own',
  provider: 'apple',
  orgId: 'o1',
  label: 'North signing',
  identifier: 'pass.mobile.passbook.north',
  kind: 'managed',
  status: 'active',
  notBefore: 1_600_000_000_000,
  notAfter: Date.now() + 100 * 86_400_000,
  rotation: 'auto',
  nextRotationAt: Date.UTC(2027, 9, 1, 12),
  issuing: true,
  isDefault: false,
  passCount: 0,
  createdAt: 1_600_000_000_000,
};
const north = membershipFixture('o1', { orgName: 'North' });

describe('wallet accounts per scope', () => {
  it('lists every identity on the platform page, which names no scope in its labels', async () => {
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        '/api/v1/wallet-identities': () =>
          json({
            items: [
              own,
              {
                ...own,
                id: 'i-2',
                identifier: 'pass.im.plrs.wallet',
                kind: 'platform',
                orgId: null,
              },
            ],
            nextCursor: null,
          }),
        '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Wallet accounts', level: 1 })).toBeVisible();
    expect(await screen.findByText('pass.mobile.passbook.north')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'pass.im.plrs.wallet' })).toBeInTheDocument();
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
        '/api/v1/orgs/o1/memberships': () => json({ items: [], nextCursor: null }),
        '/api/v1/orgs/o1/invitations': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Invite member' })).toBeInTheDocument();
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
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/orgs/o1/') && !String(url).includes('pass-setup'),
      ),
    ).toBe(false);
    expect(within(document.body).queryByRole('button', { name: 'Invite member' })).toBeNull();
  });
});
