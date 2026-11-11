import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ADMIN_NAV } from '../../lib/nav.ts';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';
import { json, membershipFixture, renderApp, sessionFixture } from '../../lib/test-utils.tsx';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  delete document.documentElement.dataset.theme;
});
afterEach(() => vi.unstubAllGlobals());

describe('route guards in the app', () => {
  it('sends signed-out visitors to /login with next', async () => {
    const { router } = await renderApp('/account?tab=emails', { session: 'anon' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ next: '/account?tab=emails' });
    expect(await screen.findByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument();
  });

  it('does not require a session for /login', async () => {
    const { router } = await renderApp('/login', { session: 'anon' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('sends signed-out visitors of /admin to /login', async () => {
    const { router } = await renderApp('/admin/passes', { session: 'anon' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ next: '/admin/passes' });
  });

  it('shows the forbidden page to a signed-in non-admin on /admin', async () => {
    const { container } = await renderApp('/admin', { session: 'user' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    // The buddy is sad beside the lock.
    expect(container.querySelector('[data-buddy] [data-part="w"]')).toHaveAttribute(
      'data-mood',
      'sad',
    );
    expect(container.querySelector('[data-buddy] [data-art="lock"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in as someone else' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
  });

  it('sends a member from /admin to the first section their role covers', async () => {
    const { router } = await renderApp('/admin', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['read_only'],
          capabilities: ['org:read', 'scanning:read'],
        }),
      ],
      handlers: { '/api/v1/scan-sessions': () => json({ items: [], nextCursor: null }) },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/scanning'));
    expect(router.state.location.search).toMatchObject({ orgId: 'o1' });
    expect(screen.queryByRole('heading', { name: 'You do not have access' })).toBeNull();
  });

  it('keeps platform pages available to an admin with no memberships', async () => {
    await renderApp('/admin/users', { session: 'admin', memberships: [] });
    expect(
      await screen.findByRole('heading', { name: 'Platform accounts', level: 1 }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    for (const name of [
      'Users',
      'Organizations',
      'Status',
      'Apple identities',
      'API keys',
      'Settings',
    ]) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole('link', { name: 'Passes' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Templates' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /^Organization filter/ })).toBeNull();
  });

  it('keeps API keys available to a platform admin without membership', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/api-keys': () => json({ items: [], nextCursor: null, revokedCount: 0 }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'API keys', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Admin' })).toBeInTheDocument();
  });

  it('does not label platform key counts with a remembered tenant selection', async () => {
    localStorage.setItem('wallet-org-filter', 'o1');
    await renderApp('/admin/api-keys', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Henrys' })],
      handlers: {
        '/api/v1/api-keys': () =>
          json({
            items: [
              {
                id: 'k1',
                orgId: null,
                name: 'Platform key',
                prefix: 'abc123',
                scopes: ['passes:read'],
                createdBy: 'u1',
                createdByName: null,
                createdAt: 1_700_000_000_000,
                lastUsedAt: null,
                expiresAt: null,
                revokedAt: null,
              },
            ],
            nextCursor: null,
            revokedCount: 0,
          }),
      },
    });
    const filter = await screen.findByRole('combobox', { name: /^Organization filter/ });
    await waitFor(() => expect(filter).toHaveTextContent('Henrys'));
    expect(await screen.findByText('1 API key')).toBeInTheDocument();
    expect(screen.queryByText(/in Henrys/)).toBeNull();
  });

  it('labels tenant counts from the selected authorized membership', async () => {
    await renderApp('/admin/passes', {
      session: 'user',
      memberships: [membershipFixture('o1', { orgName: 'Henrys' })],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/passes': () =>
          json({
            items: [
              {
                id: 'p1',
                orgId: 'o1',
                templateId: 't1',
                templateVersion: '1',
                identityId: 'i1',
                serial: 'S-1',
                title: 'Ada Lovelace',
                subtitle: null,
                externalId: null,
                status: 'active',
                version: 1,
                connectionId: null,
                syncErrorCode: null,
                holderEmail: 'ada@example.com',
                holderState: 'owned',
                ownerUserId: null,
                modifiedAt: 1,
                createdAt: 1,
              },
            ],
            nextCursor: null,
          }),
      },
    });
    expect(await screen.findByText('1 pass in Henrys')).toBeInTheDocument();
  });

  it('denies API key pages and actions to a tenant integration administrator', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/admin/api-keys?orgId=o1&new=1', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['integration_admin'],
          capabilities: ['org:read', 'integrations:read', 'integrations:manage'],
        }),
      ],
      handlers: {
        '/api/v1/api-keys': () => json({ items: [], nextCursor: null, revokedCount: 0 }),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).queryByRole('link', { name: 'API keys' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/api-keys'))).toBe(
      false,
    );
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'api key');
    expect(screen.queryByRole('option', { name: 'API keys' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'New API key' })).toBeNull();
  });

  it('denies a platform admin without membership access to a tenant route', async () => {
    const { fetchMock } = await renderApp('/admin/passes', {
      session: 'admin',
      memberships: [],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Passes', level: 1 })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/passes'))).toBe(
      false,
    );
  });

  it('denies a member a tenant route without its capability', async () => {
    const { fetchMock } = await renderApp('/admin/templates', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['read_only'],
          capabilities: ['org:read', 'passes:read'],
        }),
      ],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/templates': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    // It names the organization and the section, and leads to one the role does open.
    expect(screen.getByText('o1: your role does not include Templates.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Passes' })).toHaveAttribute(
      'href',
      '/admin/passes?orgId=o1',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/templates'))).toBe(
      false,
    );
  });

  it('does not grant message access from pass capabilities', async () => {
    const { fetchMock } = await renderApp('/admin/messages', {
      session: 'admin',
      memberships: [
        membershipFixture('o1', {
          roles: ['pass_operator'],
          capabilities: ['org:read', 'passes:read', 'passes:operate'],
        }),
      ],
      selectedOrg: 'o1',
      handlers: { '/api/v1/broadcasts': () => json({ items: [], nextCursor: null }) },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).queryByRole('link', { name: 'Messages' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/broadcasts'))).toBe(
      false,
    );
  });

  it('allows tenant message readers without granting pass or message write access', async () => {
    const scopes: (string | null)[] = [];
    await renderApp('/admin/messages', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['read_only'],
          capabilities: ['org:read', 'messages:read'],
        }),
      ],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/broadcasts': (url) => {
          scopes.push(url.searchParams.get('orgId'));
          return json({ items: [], nextCursor: null });
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Messages', level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Messages' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Passes' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New message' })).toBeNull();
    await waitFor(() => expect(scopes).toContain('o1'));
    expect(scopes).not.toContain(null);
  });

  it('does not grant access through a revoked membership', async () => {
    const { fetchMock } = await renderApp('/admin/passes', {
      session: 'admin',
      memberships: [membershipFixture('o1', { revokedAt: 1_700_000_000_001 })],
      selectedOrg: 'o1',
      handlers: { '/api/v1/passes': () => json({ items: [], nextCursor: null }) },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/passes'))).toBe(
      false,
    );
  });

  it.each([
    ['empty', 'orgId='],
    ['overlong', `orgId=${'x'.repeat(101)}`],
    ['unknown', 'orgId=foreign'],
    ['duplicate with member first', 'orgId=o1&orgId=foreign'],
    ['duplicate with member last', 'orgId=foreign&orgId=o1'],
  ] as const)(
    'denies the pass wizard for an explicit %s organization ID',
    async (_label, query) => {
      localStorage.setItem('wallet-org-filter', 'o1');
      const { router, fetchMock } = await renderApp(`/admin/passes/new?${query}`, {
        session: 'user',
        memberships: [
          membershipFixture('o1', {
            roles: ['pass_operator'],
            capabilities: ['org:read', 'passes:read', 'passes:operate'],
          }),
        ],
        handlers: {
          '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
          '/api/v1/passes': () => json({ items: [], nextCursor: null }),
          '/api/v1/templates': () => json({ items: [], nextCursor: null }),
        },
      });
      expect(
        await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(localStorage.getItem('wallet-org-filter')).toBeNull());
      expect(screen.queryByRole('heading', { name: 'New pass', level: 1 })).toBeNull();
      expect(router.state.location.search.orgId).not.toBe('o1');
      for (const path of ['/api/v1/orgs', '/api/v1/passes', '/api/v1/templates']) {
        expect(
          fetchMock.mock.calls.some(
            ([url]) => new URL(String(url), 'http://localhost').pathname === path,
          ),
        ).toBe(false);
      }
    },
  );

  it('opens the pass wizard without automatically choosing an organization', async () => {
    const { router, fetchMock } = await renderApp('/admin/passes/new', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['pass_operator'],
          capabilities: ['org:read', 'passes:read', 'passes:operate'],
        }),
      ],
    });
    expect(await screen.findByRole('heading', { name: 'New pass', level: 1 })).toBeInTheDocument();
    expect(router.state.location.search).not.toHaveProperty('orgId');
    expect(localStorage.getItem('wallet-org-filter')).toBeNull();
    for (const path of ['/api/v1/passes', '/api/v1/templates']) {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => new URL(String(url), 'http://localhost').pathname === path,
        ),
      ).toBe(false);
    }
  });

  it('lets a plain user into the portal and hides the Admin link', async () => {
    const { queryClient } = await renderApp('/account', { session: 'user' });
    expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeInTheDocument();
    await waitFor(() =>
      expect(queryClient.getQueryData(membershipsQuery.queryKey)).toEqual({ items: [] }),
    );
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  it('shows an Admin link to admins in the portal', async () => {
    await renderApp('/', { session: 'admin' });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    // Hidden on phones, where the header has no room; the account menu carries it there.
    expect(within(nav).getByRole('link', { name: 'Admin' })).toHaveClass('max-sm:hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Admin' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });

  it('links a single-organization member straight into that organization', async () => {
    const user = userEvent.setup();
    const { router, fetchMock } = await renderApp('/account', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['read_only'],
          capabilities: ['org:read', 'passes:read'],
        }),
      ],
      handlers: { '/api/v1/passes': () => json({ items: [], nextCursor: null }) },
    });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    // The choice is the only one there is, and it stays explicit in the URL.
    expect(await within(nav).findByRole('link', { name: 'Admin' })).toHaveAttribute(
      'href',
      '/admin/passes?orgId=o1',
    );
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    const admin = await screen.findByRole('menuitem', { name: 'Admin' });
    expect(admin).toHaveAttribute('href', '/admin/passes?orgId=o1');
    await user.click(admin);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes'));
    expect(router.state.location.search).toMatchObject({ orgId: 'o1' });
    expect(await screen.findByRole('heading', { name: 'Passes', level: 1 })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/passes'))).toBe(
      true,
    );
  });

  it('asks a member with several organizations to choose one', async () => {
    const user = userEvent.setup();
    const { router, fetchMock } = await renderApp('/account', {
      session: 'user',
      memberships: [
        membershipFixture('o1', { capabilities: ['org:read', 'passes:read'] }),
        membershipFixture('o2', { capabilities: ['org:read', 'passes:read'] }),
      ],
      handlers: { '/api/v1/passes': () => json({ items: [], nextCursor: null }) },
    });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const admin = await within(nav).findByRole('link', { name: 'Admin' });
    expect(admin).toHaveAttribute('href', '/admin/passes');
    await user.click(admin);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes'));
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.search).not.toHaveProperty('orgId');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/passes'))).toBe(
      false,
    );
  });

  it("keeps Admin out of a plain user's account menu", async () => {
    const { queryClient } = await renderApp('/', { session: 'user' });
    await waitFor(() =>
      expect(queryClient.getQueryData(membershipsQuery.queryKey)).toEqual({ items: [] }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Account menu' }));
    await screen.findByRole('menuitem', { name: 'Account' });
    expect(screen.queryByRole('menuitem', { name: 'Admin' })).toBeNull();
  });

  it('renders the holder not found page with the lost wallet', async () => {
    const { container } = await renderApp('/nope', { session: 'user' });
    expect(
      await screen.findByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeInTheDocument();
    const art = container.querySelector('[data-art]');
    expect(art).toHaveAttribute('data-art', 'wallet');
    expect(art).toHaveAttribute('data-state', 'lost');
  });

  it('renders the admin not found page as the holder one, with a palette search', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/admin/nope', { session: 'admin' });
    expect(
      await screen.findByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeInTheDocument();
    // A route not found is the lost buddy peeking (an item not found mends the torn pass).
    const buddy = container.querySelector('main [data-buddy]');
    expect(buddy).toHaveAttribute('data-scene', 'peek');
    expect(buddy?.querySelector('[data-art="wallet"]')).toHaveAttribute('data-state', 'lost');
    expect(buddy?.querySelector('[data-art="torn"]')).toBeNull();
    expect(container.querySelector('main [data-part="w"]')).toHaveAttribute('data-mood', 'sad');
    expect(screen.getByRole('link', { name: 'Go to Overview' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('combobox', { name: 'Search' })).toBeInTheDocument();
  });

  it('shows a session fetch failure instead of the page', async () => {
    const { findByRole } = await renderApp('/', {
      handlers: { '/api/v1/session': () => new Response('boom', { status: 500 }) },
    });
    expect(await findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
  });
});

describe('admin layout', () => {
  it('lists every IA section, marks the current one, and has no a11y violations', async () => {
    const { container } = await renderApp('/admin/passes', {
      session: 'admin',
      memberships: [membershipFixture('o1')],
      selectedOrg: 'o1',
    });
    await screen.findByRole('heading', { name: 'Passes', level: 1 });
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(ADMIN_NAV.map((i) => i.label));
    expect(within(nav).getByRole('link', { name: 'Passes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('filters member navigation and palette actions by the selected capabilities', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['read_only'],
          capabilities: ['org:read', 'passes:read'],
        }),
        membershipFixture('o2', {
          roles: ['read_only', 'template_author'],
          capabilities: ['org:read', 'passes:read', 'templates:read', 'templates:author'],
        }),
      ],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Passes', level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Passes' })).toBeInTheDocument();
    for (const name of ['Templates', 'Connections', 'Scanning', 'Users']) {
      expect(within(nav).queryByRole('link', { name })).toBeNull();
    }
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'templates');
    expect(screen.queryByRole('option', { name: 'Templates' })).toBeNull();
    await user.clear(input);
    await user.type(input, 'new pass');
    expect(screen.queryByRole('option', { name: 'New pass' })).toBeNull();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'o2' }));
    const templates = await within(nav).findByRole('link', { name: 'Templates' });
    expect(within(nav).queryByRole('link', { name: 'Users' })).toBeNull();
    await user.click(templates);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/templates'));
    expect(router.state.location.search).toMatchObject({ orgId: 'o2' });
    expect(await screen.findByRole('heading', { name: 'Templates', level: 1 })).toBeInTheDocument();
  });

  it('links a member to the explicitly scoped organization workspace', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes', {
      session: 'user',
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'passes:read'] })],
      selectedOrg: 'o1',
      handlers: { '/api/v1/passes': () => json({ items: [], nextCursor: null }) },
    });
    await screen.findByRole('heading', { name: 'Passes', level: 1 });
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    const organization = within(nav).getByRole('link', { name: 'Organization' });
    const href = new URL(organization.getAttribute('href')!, 'http://localhost');
    expect(href.pathname).toBe('/admin/orgs/o1');
    expect(href.searchParams.get('view')).toBe('workspace');
    expect(href.searchParams.get('orgId')).toBe('o1');
    await user.click(organization);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orgs/o1'));
    expect(router.state.location.search).toMatchObject({ view: 'workspace', orgId: 'o1' });
  });

  it('uses the workspace view for the member organization palette entry', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes', {
      session: 'user',
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'passes:read'] })],
      selectedOrg: 'o1',
      handlers: { '/api/v1/passes': () => json({ items: [], nextCursor: null }) },
    });
    await screen.findByRole('heading', { name: 'Passes', level: 1 });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'Organization');
    await user.click(screen.getByRole('option', { name: 'Organization' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orgs/o1'));
    expect(router.state.location.search).toMatchObject({ view: 'workspace', orgId: 'o1' });
  });

  it('collapses the nav into a sheet via the menu button', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await user.click(await screen.findByRole('button', { name: 'Menu' }));
    const sheet = await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(within(sheet).getByRole('link', { name: 'Users' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await screen.findByRole('heading', { name: 'Platform accounts', level: 1 }),
    ).toBeInTheDocument();
  });

  it('opens the command palette with Ctrl+K and navigates', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'settings');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings'));
  });

  it('returns focus to what had it when the palette closes', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    // The bar has an icon button for phones and a wide one; either returns focus the same way.
    const trigger = screen.getAllByRole('button', { name: /^Search/ }).at(-1)!;
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search' })).toBeNull());
    expect(trigger).toHaveFocus();
    // Opened from the keyboard on another control, it goes back there too.
    const link = within(screen.getByRole('navigation', { name: 'Admin' })).getAllByRole('link')[0]!;
    link.focus();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('combobox', { name: 'Search' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search' })).toBeNull());
    expect(link).toHaveFocus();
  });

  it('hides principal-keyed directory results while the session refreshes', async () => {
    const user = userEvent.setup();
    let refreshing = false;
    // The web test target is ES2023, before Promise.withResolvers.
    let resolveSession!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    const { queryClient } = await renderApp('/admin', {
      session: 'admin',
      handlers: {
        '/api/v1/session': () => (refreshing ? pending : json(sessionFixture('admin'))),
        '/api/v1/orgs': () =>
          json({
            items: [
              {
                id: 'harbor',
                name: 'Harbor Gym',
                slug: 'harbor',
                status: 'active',
                createdAt: 1,
                counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
                countsCapped: false,
              },
            ],
            nextCursor: null,
          }),
      },
    });
    await screen.findByRole('navigation', { name: 'Admin' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'harbor');
    expect(await screen.findByRole('option', { name: 'Harbor Gym' })).toBeInTheDocument();
    expect(queryClient.getQueryData(['palette', 'org-directory', 'u1', 'harbor'])).toBeDefined();

    refreshing = true;
    let refresh!: Promise<unknown>;
    try {
      act(() => {
        refresh = queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      });
      await waitFor(() =>
        expect(queryClient.getQueryState(sessionQuery.queryKey)?.fetchStatus).toBe('fetching'),
      );
      await waitFor(() => expect(screen.queryByRole('option', { name: 'Harbor Gym' })).toBeNull());
    } finally {
      resolveSession(json(sessionFixture('admin')));
      await act(async () => {
        await refresh;
      });
    }
  });

  it('searches passes from the palette after two characters and links to the result', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const { router } = await renderApp('/admin/passes', {
      session: 'admin',
      memberships: [membershipFixture('o1')],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/passes': (url) => {
          if (url.searchParams.has('q')) seen.push(url.search);
          return json({
            items: [
              {
                id: 'p1',
                orgId: 'o1',
                templateId: 't1',
                templateVersion: '1',
                identityId: 'i1',
                serial: 'S-1',
                title: 'Ada Lovelace',
                subtitle: null,
                externalId: null,
                status: 'active',
                version: 1,
                connectionId: null,
                syncErrorCode: null,
                holderEmail: 'ada@example.com',
                holderState: 'owned',
                ownerUserId: null,
                modifiedAt: 1,
                createdAt: 1,
              },
            ],
            nextCursor: null,
          });
        },
      },
    });
    await screen.findByRole('heading', { name: 'Passes', level: 1 });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'a');
    expect(seen).toEqual([]);
    await user.type(input, 'da');
    const option = await screen.findByRole('option', { name: /Ada Lovelace/ });
    expect(seen.at(-1)).toContain('q=ada');
    expect(screen.queryByText('No results')).toBeNull();
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes/p1'));
  });

  it('moves focus to the new page heading and announces it on navigation', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    const heading = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
    const title = heading.textContent ?? '';
    await waitFor(() => expect(screen.getByRole('status', { name: '' })).toHaveTextContent(title));
  });

  it('skip link focuses main content', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('lists only memberships in the scope switcher and writes the choice to the URL', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes', {
      session: 'admin',
      memberships: [
        membershipFixture('o1', { orgName: 'Henrys', orgSlug: 'henrys' }),
        membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' }),
        membershipFixture('o3', { orgName: 'Retired', revokedAt: 1_700_000_000_001 }),
      ],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/orgs': () =>
          json({
            items: [
              {
                id: 'other',
                name: 'Directory only',
                slug: 'other',
                status: 'active',
                defaultIdentityId: null,
                branding: {},
                createdAt: 1,
                updatedAt: 1,
                counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
                countsCapped: false,
              },
            ],
            nextCursor: null,
          }),
      },
    });
    const filter = await screen.findByRole('combobox', { name: /^Organization filter/ });
    expect(filter).toHaveAccessibleDescription(
      'Filters supported views; it does not change your access.',
    );
    await waitFor(() => expect(filter).toHaveTextContent('Henrys'));
    await user.click(filter);
    expect(screen.queryByRole('option', { name: 'Directory only' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Retired' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'All organizations' })).toBeNull();
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await waitFor(() => expect(filter).toHaveTextContent('Harbor'));
    await waitFor(() => expect(router.state.location.search).toEqual({ orgId: 'o2' }));
    expect(localStorage.getItem('wallet-org-filter')).toBe('o2');
  });
});
