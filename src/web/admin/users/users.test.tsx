import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { parseUsersSearch } from './users-page.tsx';

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u2',
  name: 'Ada Lovelace',
  primaryEmail: 'ada@example.com',
  status: 'active',
  lastRoles: ['user'],
  createdAt: 1_700_000_000_000,
  lastLoginAt: 1_700_100_000_000,
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...user(),
  emails: [
    { email: 'ada@example.com', verifiedVia: 'oidc', verifiedAt: 1_700_000_000_000 },
    { email: 'ada@work.example', verifiedVia: 'admin', verifiedAt: 1_700_000_000_000 },
  ],
  identities: [
    {
      provider: 'pocket-id',
      subject: 's1',
      emailClaim: 'ada@example.com',
      emailVerified: true,
      groups: ['wallet-users'],
      lastUsedAt: null,
    },
  ],
  sessions: [
    {
      id: 'sess1',
      amr: 'oidc',
      roles: ['user'],
      createdAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_000,
      expiresAt: 4_000_000_000_000,
      revokedAt: null,
      userAgent: 'Safari',
    },
  ],
  passes: [
    { id: 'p1', title: 'Gold card', templateName: 'Gold', orgName: 'Henrys', status: 'active' },
  ],
  passCount: 1,
  recentAudit: [],
  ...over,
});

describe('parseUsersSearch', () => {
  it('drops blanks and unknown statuses', () => {
    expect(parseUsersSearch({ q: '  ', status: 'bogus' })).toEqual({
      q: undefined,
      status: undefined,
    });
    expect(parseUsersSearch({ q: ' ada ', status: 'disabled' })).toEqual({
      q: 'ada',
      status: 'disabled',
    });
  });
});

describe('users list', () => {
  it('lists users and is accessible', async () => {
    const { container } = await renderApp('/admin/users', {
      session: 'admin',
      handlers: {
        '/api/v1/users': () => json({ items: [user()], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('link', { name: /Ada Lovelace/ })).toHaveAttribute(
      'href',
      '/admin/users/u2',
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it('passes the search term and status from the URL', async () => {
    const { fetchMock } = await renderApp('/admin/users?q=ada&status=disabled', {
      session: 'admin',
      handlers: { '/api/v1/users': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No users match')).toBeInTheDocument();
    const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/users?'));
    expect(call).toContain('q=ada');
    expect(call).toContain('status=disabled');
  });

  it('loads the next page with the cursor', async () => {
    const { fetchMock } = await renderApp('/admin/users', {
      session: 'admin',
      handlers: {
        '/api/v1/users': (url) =>
          url.searchParams.get('cursor')
            ? json({
                items: [user({ id: 'u3', name: 'Bob', primaryEmail: 'bob@example.com' })],
                nextCursor: null,
              })
            : json({ items: [user()], nextCursor: 'c1' }),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /Bob/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('cursor=c1'))).toBe(true);
  });

  it('shows the empty and error states', async () => {
    await renderApp('/admin/users', {
      session: 'admin',
      handlers: { '/api/v1/users': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No users yet')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    await renderApp('/admin/users', {
      session: 'admin',
      handlers: { '/api/v1/users': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
  });
});

describe('user detail', () => {
  it('shows emails, identities, sessions and passes without a11y violations', async () => {
    const { container } = await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: { '/api/v1/users/u2': () => json(detail()) },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('ada@work.example')).toBeInTheDocument();
    expect(screen.getByText('wallet-users')).toBeInTheDocument();
    expect(screen.getByText('Safari')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gold card' })).toHaveAttribute(
      'href',
      '/admin/passes/p1',
    );
    expect(screen.getByText('Gold · Henrys')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('disables a user only after confirmation', async () => {
    const patches: unknown[] = [];
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': (_u, init) => {
          if (init?.method === 'PATCH') {
            patches.push(JSON.parse(String(init.body)));
            return json(user({ status: 'disabled' }));
          }
          return json(detail());
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(patches).toEqual([]);
    await ui.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(patches).toEqual([{ status: 'disabled' }]));
  });

  it('offers Enable for a disabled user', async () => {
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: { '/api/v1/users/u2': () => json(detail({ status: 'disabled' })) },
    });
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('revokes all sessions after confirmation', async () => {
    let revoked = 0;
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': () => json(detail()),
        '/api/v1/users/u2/sessions/revoke': () => {
          revoked++;
          return json({ ok: true });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Revoke all' }));
    await ui.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() => expect(revoked).toBe(1));
  });

  it('shows the API error when adding an email fails', async () => {
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': () => json(detail()),
        '/api/v1/users/u2/emails': () =>
          problem(409, 'email_taken', 'Email belongs to another user.'),
      },
    });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText('Add verified email'), 'x@example.com');
    await ui.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Email belongs to another user.')).toBeInTheDocument();
  });

  it('shows not found', async () => {
    await renderApp('/admin/users/nope', { session: 'admin' });
    expect(await screen.findByText('User not found')).toBeInTheDocument();
  });
});
