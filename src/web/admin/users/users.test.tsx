import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { parseUsersSearch } from './users-search.ts';

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u2',
  name: 'Ada Lovelace',
  primaryEmail: 'ada@example.com',
  status: 'active',
  lastRoles: ['user'],
  createdAt: 1_700_000_000_000,
  lastLoginAt: 1_700_100_000_000,
  passCount: 3,
  signInMethods: ['oidc', 'magic_link'],
  ...over,
});

const session = (over: Record<string, unknown> = {}) => ({
  id: 'sess1',
  amr: 'oidc',
  roles: ['user'],
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_000_000,
  expiresAt: 4_000_000_000_000,
  revokedAt: null,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  current: false,
  method: 'Polaris ID',
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
      provider: 'pocketid',
      subject: 's1',
      emailClaim: 'ada@example.com',
      emailVerified: true,
      groups: ['wallet-users'],
      lastUsedAt: null,
    },
  ],
  sessions: [session()],
  passes: [],
  passCount: 1,
  recentAudit: [],
  ...over,
});

const settings = () =>
  json({ items: [], oidc: { issuer: 'https://id.example', adminGroup: null, userGroup: null } });

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
  it('lists users with avatar, passes link and sign-in methods, accessibly', async () => {
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
    const passes = screen.getByRole('link', { name: /3 passes held by ada@example.com/ });
    expect(passes.getAttribute('href')).toBe('/admin/passes?q=ada%40example.com');
    expect(screen.getByText('Polaris ID, Email link')).toBeInTheDocument();
    // Role chips are neutral, never accent or success.
    const role = screen.getByText('User', { selector: 'span.rounded-full' });
    expect(role.className).toContain('text-fg-muted');
    expect(role.className).not.toMatch(/text-(accent|success)/);
    expect(screen.getByText('1 user')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('passes the search term and status from the URL; filtered empty shows people and lens', async () => {
    const { fetchMock, container } = await renderApp('/admin/users?q=zzzz&status=disabled', {
      session: 'admin',
      handlers: { '/api/v1/users': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No users match')).toBeInTheDocument();
    expect(container.querySelector('[data-art="people"]')).not.toBeNull();
    expect(container.querySelector('[data-art="lens-overlay"]')).not.toBeNull();
    const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/users?'));
    expect(call).toContain('q=zzzz');
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

  it('shows the empty state', async () => {
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
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });
});

describe('user detail', () => {
  it('shows emails, identities, sessions and the account aside without a11y violations', async () => {
    const { container } = await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: { '/api/v1/users/u2': () => json(detail()), '/api/v1/settings': settings },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('ada@work.example')).toBeInTheDocument();
    expect(screen.getByText('wallet-users')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.queryByText(/Mozilla/)).toBeNull();
    expect(screen.getByRole('link', { name: /1 pass/ })).toHaveAttribute(
      'href',
      '/admin/passes?q=ada%40example.com',
    );
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Audit log' }),
    ).toBeInTheDocument();
    expect(await screen.findAllByRole('link', { name: /Manage in Polaris ID/ })).toHaveLength(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('on your own page says This is you, links Account and drops self-harming actions', async () => {
    await renderApp('/admin/users/u1', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u1': () =>
          json(detail({ id: 'u1', sessions: [session({ current: true }), session({ id: 's2' })] })),
      },
    });
    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(screen.getByText(/This is you\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Account' })).toHaveAttribute(
      'href',
      '/admin/account',
    );
    // Other devices can still be revoked one by one; Revoke all would end this session too.
    expect(screen.getAllByRole('button', { name: /^Revoke Safari on iOS/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('revokes one session without touching the others', async () => {
    const deleted: string[] = [];
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': () => json(detail({ sessions: [session(), session({ id: 's2' })] })),
        '/api/v1/users/u2/sessions/s2': (_u, init) => {
          deleted.push(String(init?.method));
          return json({ ok: true });
        },
      },
    });
    const ui = userEvent.setup();
    const buttons = await screen.findAllByRole('button', { name: /^Revoke Safari on iOS/ });
    await ui.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(deleted).toEqual(['DELETE']));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Revoke Safari on iOS/ })).toHaveLength(1),
    );
  });

  it('disables at once and Undo enables again', async () => {
    const patches: { status: string }[] = [];
    let status = 'active';
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': (_u, init) => {
          if (init?.method === 'PATCH') {
            patches.push(JSON.parse(String(init.body)));
            status = patches.at(-1)?.status ?? status;
            return json(user({ status }));
          }
          return json(detail({ status }));
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Disable' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(patches).toEqual([{ status: 'disabled' }]));
    await ui.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(patches).toEqual([{ status: 'disabled' }, { status: 'active' }]));
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
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Sign Ada Lovelace out everywhere?',
    });
    await ui.click(within(dialog).getByRole('button', { name: 'Revoke all' }));
    await waitFor(() => expect(revoked).toBe(1));
  });

  it('asks before removing an email, in the shared words', async () => {
    let removed = '';
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': () => json(detail()),
        '/api/v1/users/u2/emails/ada%40work.example': (url, init) => {
          removed = `${init?.method} ${url.pathname}`;
          return json({ ok: true });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Actions for ada@work.example' }));
    await ui.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove ada@work.example?' });
    expect(
      within(dialog).getByText(
        'They can no longer sign in with it, and passes sent to it leave their list.',
      ),
    ).toBeVisible();
    await ui.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removed).toBe('DELETE /api/v1/users/u2/emails/ada%40work.example'));
  });

  it('makes a verified email primary after confirming', async () => {
    const posts: string[] = [];
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': () => json(detail()),
        '/api/v1/users/u2/emails/ada%40work.example/primary': (url) => {
          posts.push(url.pathname);
          return json(detail({ primaryEmail: 'ada@work.example' }));
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Actions for ada@work.example' }));
    await ui.click(await screen.findByRole('menuitem', { name: 'Make primary' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Sign-in emails go to ada@work.example.')).toBeVisible();
    await ui.click(within(dialog).getByRole('button', { name: 'Make primary' }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it('shows No emails for an account without addresses and no Polaris link without an identity', async () => {
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': () => json(detail({ emails: [], identities: [] })),
        '/api/v1/settings': settings,
      },
    });
    expect(await screen.findByText('No emails')).toBeInTheDocument();
    expect(screen.getByLabelText('Add verified email')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Polaris ID/ })).toBeNull();
  });

  it('shows the API error when adding an email fails and keeps the address typed', async () => {
    await renderApp('/admin/users/u2', {
      session: 'admin',
      handlers: {
        '/api/v1/users/u2': () => json(detail()),
        '/api/v1/users/u2/emails': () =>
          problem(409, 'email_taken', 'Email belongs to another user.'),
      },
    });
    const ui = userEvent.setup();
    const field = await screen.findByLabelText('Add verified email');
    await ui.type(field, 'x@example.com');
    await ui.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Email belongs to another user.')).toBeInTheDocument();
    expect(field).toHaveValue('x@example.com');
  });

  it('shows not found under the page header, with the way back', async () => {
    await renderApp('/admin/users/nope', { session: 'admin' });
    expect(await screen.findByText('User not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'User' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to users' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
  });
});
