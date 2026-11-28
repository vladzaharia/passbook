import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';

const detail = {
  id: 'u2',
  name: 'Ada Lovelace',
  primaryEmail: 'ada@example.com',
  status: 'active',
  lastRoles: ['user'],
  createdAt: 1_700_000_000_000,
  lastLoginAt: null,
  signInMethods: ['oidc'],
  emails: [],
  identities: [],
  sessions: [],
  passes: [],
  passCount: 2,
  recentAudit: [],
};
const pass = (over: Record<string, unknown>) => ({
  id: 'p1',
  orgId: 'o1',
  orgName: 'Northwind',
  orgStatus: 'active',
  timeZone: 'America/Los_Angeles',
  templateName: 'Gym pass',
  status: 'active',
  holding: 'owned',
  channels: ['apple'],
  issuedAt: Date.UTC(2026, 10, 1, 3),
  updatedAt: Date.UTC(2026, 10, 2, 3),
  ...over,
});
const open = (passes: unknown[]) => ({
  '/api/v1/users/u2': () => json(detail),
  '/api/v1/users/u2/passes': () => json({ items: passes, nextCursor: null }),
  '/api/v1/settings': () => json({ items: [] }),
});

describe('user passes section', () => {
  it('lists passes across orgs in each org zone; links only the orgs the viewer can open', async () => {
    await renderApp('/admin/users/u2', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Northwind' })],
      handlers: open([
        pass({}),
        pass({
          id: 'p2',
          orgId: 'o9',
          orgName: 'Elsewhere',
          timeZone: 'Asia/Tokyo',
          holding: 'waiting',
        }),
      ]),
    });
    const list = await screen.findByRole('list', { name: 'Passes' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Northwind' })).toHaveAttribute(
      'href',
      '/admin/o/o1/passes/p1',
    );
    // 03:00 UTC on Nov 1 is still Oct 31 in Los Angeles.
    expect(rows[0]).toHaveTextContent('Issued Oct 31, 2026');
    expect(rows[0]).toHaveTextContent('Apple Wallet');
    expect(within(rows[1] as HTMLElement).queryByRole('link')).toBeNull();
    expect(rows[1]).toHaveTextContent('Elsewhere');
    expect(rows[1]).toHaveTextContent('Issued Nov 1, 2026');
    expect(rows[1]).toHaveTextContent('Waiting for sign-in');
    expect(rows[0]).not.toHaveTextContent('Waiting for sign-in');
  });

  it('shows the empty state', async () => {
    await renderApp('/admin/users/u2', { session: 'admin', handlers: open([]) });
    expect(await screen.findByText('No passes')).toBeInTheDocument();
  });

  it('shows an error with retry when the read fails', async () => {
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        ...open([]),
        '/api/v1/users/u2/passes': () => problem(500, 'x', 'x'),
      },
    });
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeInTheDocument();
  });
});
